/**
 * FFmpeg 工具：视频处理相关操作
 *
 * 关键问题：ffmpeg-static (Windows) 无法处理含非 ASCII 字符的输出路径。
 * 解决方案：ffmpeg 始终输出到系统临时目录（纯 ASCII），完成后 fs.rename 到目标位置。
 *
 * 打包兼容：electron-builder 将二进制放入 resources/app.asar.unpacked/，
 * 需要从 asarUnpack 路径解析 ffmpeg 可执行文件。
 *
 * 元数据获取：直接用 ffmpeg -i 解析 stderr，无需 ffprobe-static。
 *
 * GPU 加速：启动时探测 NVIDIA(h264_nvenc) / AMD(h264_amf) / Intel(h264_qsv)，
 * 优先使用 GPU 编码器，不可用时降级到 CPU(libx264)。
 * 注意：GPU 编码器不支持 -crf，改用 CBR 码率控制。
 */
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolveUnpacked(p) {
  return p.replace('app.asar', 'app.asar.unpacked');
}

const ffmpegPath = resolveUnpacked(require('ffmpeg-static'));
ffmpeg.setFfmpegPath(ffmpegPath);

const TEMP_DIR = path.join(os.tmpdir(), 'vad-cut');

function makeTempPath(ext) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  return path.join(TEMP_DIR, `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

// ─── GPU 编码器探测 ──────────────────────────────────────────────────────────

/**
 * 测试指定编码器是否可用：生成 1 帧黑色视频，成功则返回 true
 */
function testEncoder(encoder) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=1',
      '-vframes', '1',
      '-c:v', encoder,
      '-f', 'null', '-',
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { resolve(code === 0); });
    proc.on('error', () => resolve(false));
  });
}

// 候选编码器优先级：NVIDIA > AMD > Intel > CPU
// hwaccel: 硬件解码加速类型（与编码器配套使用）
const GPU_CANDIDATES = [
  {
    encoder: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    hwaccel: 'cuda',
    extraOpts: ['-rc', 'cbr', '-preset', 'p4', '-spatial-aq', '1'],
  },
  {
    encoder: 'h264_amf',
    label: 'AMD AMF',
    hwaccel: 'd3d11va',
    extraOpts: ['-rc', 'cbr', '-quality', 'balanced'],
  },
  {
    encoder: 'h264_qsv',
    label: 'Intel QSV',
    hwaccel: 'qsv',
    extraOpts: ['-preset', 'medium', '-look_ahead', '0'],
  },
];

// 缓存探测结果，{ encoder, label, extraOpts } 或 null（使用 CPU）
let _encoderCache = undefined; // undefined = 未探测，null = 无 GPU

async function detectEncoder() {
  if (_encoderCache !== undefined) return _encoderCache;

  for (const candidate of GPU_CANDIDATES) {
    const ok = await testEncoder(candidate.encoder);
    if (ok) {
      _encoderCache = candidate;
      return candidate;
    }
  }
  _encoderCache = null;
  return null;
}

/** 返回当前选用的编码器说明（供日志显示） */
async function getEncoderInfo() {
  const enc = await detectEncoder();
  return enc ? `${enc.label} (${enc.encoder})` : 'CPU (libx264)';
}

// ─── 元数据 ──────────────────────────────────────────────────────────────────

function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn(ffmpegPath, ['-i', videoPath], { windowsHide: true });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', () => {
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (!durMatch) {
        reject(new Error(`无法解析视频时长: ${path.basename(videoPath)}`));
        return;
      }
      const duration = parseInt(durMatch[1]) * 3600
        + parseInt(durMatch[2]) * 60
        + parseFloat(durMatch[3]);

      const streams = [];
      const streamRe = /Stream #\d+:\d+[^:]*:\s*(Audio|Video)/gi;
      let m;
      while ((m = streamRe.exec(stderr)) !== null) {
        streams.push({ codec_type: m[1].toLowerCase() });
      }
      resolve({ format: { duration }, streams });
    });
    proc.on('error', reject);
  });
}

// ─── 音频提取 ────────────────────────────────────────────────────────────────

function extractAudioWav(videoPath, wavPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tmpOut = makeTempPath('.wav');

    const cmd = ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .output(tmpOut);

    if (onProgress) {
      cmd.on('progress', (info) => {
        if (info.percent != null) onProgress(Math.min(99, info.percent));
      });
    }

    cmd
      .on('error', (err) => {
        if (fs.existsSync(tmpOut)) try { fs.unlinkSync(tmpOut); } catch (_) {}
        reject(err);
      })
      .on('end', () => {
        try { moveFile(tmpOut, wavPath); resolve(); } catch (e) { reject(e); }
      })
      .run();
  });
}

// ─── 视频滤镜链 ──────────────────────────────────────────────────────────────

// 皮肤平滑（hqdn3d）+ 提亮美白（eq）+ 轻度模糊（unsharp 负值）+ 720p 缩放保持宽高比
const VIDEO_FILTER_CHAIN = [
  'scale=1280:720:force_original_aspect_ratio=decrease',
  'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  'hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5',
  'eq=brightness=0.04:contrast=1.05:saturation=0.9:gamma=0.95',
  'unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=-0.3',
].join(',');

// 去低频底噪 + FFT 自适应降噪 + 去高频噪声
const AUDIO_FILTER_CHAIN = 'highpass=f=100,afftdn=nr=12:nf=-35:nt=w:track_noise=true,lowpass=f=12000';

// ─── 剪辑 ────────────────────────────────────────────────────────────────────

/**
 * 掐头去尾剪辑视频，同时应用美化+降噪+720p/24fps/CBR 2500kbps。
 * 优先使用 GPU 编码器，不可用时自动降级到 CPU。
 */
async function trimVideo(inputPath, outputPath, startTime, endTime, totalDuration, onProgress) {
  const PAD = 0.5;
  const actualStart = Math.max(0, startTime - PAD);
  const actualEnd = endTime < 0 ? totalDuration : Math.min(totalDuration, endTime + PAD);
  const duration = actualEnd - actualStart;

  if (duration <= 0) {
    throw new Error(`剪辑时长无效: start=${actualStart}, end=${actualEnd}`);
  }

  const gpuEnc = await detectEncoder();
  const tmpOut = makeTempPath('.mp4');

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);

    if (gpuEnc) {
      // 硬件解码：在输入前加 -hwaccel，让 GPU 负责解码
      cmd.inputOptions(['-hwaccel', gpuEnc.hwaccel]);
    }

    cmd
      .seekInput(actualStart)
      .duration(duration)
      .videoFilters(VIDEO_FILTER_CHAIN)
      .audioFilters(AUDIO_FILTER_CHAIN)
      .audioCodec('aac')
      .audioBitrate('128k');

    if (gpuEnc) {
      // GPU 编码：CBR 由编码器自身的 -rc cbr 控制，再加 -maxrate/-bufsize 限顶
      cmd.videoCodec(gpuEnc.encoder);
      cmd.outputOptions([
        ...gpuEnc.extraOpts,
        '-b:v', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-r', '24',
        '-movflags', '+faststart',
      ]);
    } else {
      // CPU 降级
      cmd.videoCodec('libx264');
      cmd.outputOptions([
        '-preset', 'fast',
        '-b:v', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-r', '24',
        '-movflags', '+faststart',
      ]);
    }

    cmd.output(tmpOut);

    if (onProgress) {
      cmd.on('progress', (info) => {
        if (info.percent != null) onProgress(Math.min(99, info.percent));
      });
    }

    cmd
      .on('error', (err) => {
        if (fs.existsSync(tmpOut)) try { fs.unlinkSync(tmpOut); } catch (_) {}
        // GPU 编码失败时降级到 CPU 重试
        if (gpuEnc) {
          _encoderCache = null; // 禁用该 GPU，后续文件也走 CPU
          trimVideo(inputPath, outputPath, startTime, endTime, totalDuration, onProgress)
            .then(resolve).catch(reject);
        } else {
          reject(err);
        }
      })
      .on('end', () => {
        try { moveFile(tmpOut, outputPath); resolve(); } catch (e) { reject(e); }
      })
      .run();
  });
}

module.exports = { getVideoMetadata, extractAudioWav, trimVideo, getEncoderInfo, detectEncoder, makeTempPath };
