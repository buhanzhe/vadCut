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
 */
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 解析 ffmpeg-static 的实际可执行路径。
 * 打包后文件在 app.asar.unpacked 下，直接 require() 返回的路径在 asar 内无法执行。
 */
function resolveUnpacked(p) {
  return p.replace('app.asar', 'app.asar.unpacked');
}

const ffmpegPath = resolveUnpacked(require('ffmpeg-static'));

ffmpeg.setFfmpegPath(ffmpegPath);

const TEMP_DIR = path.join(os.tmpdir(), 'vad-cut');

/** 生成一个安全的临时文件路径（纯 ASCII） */
function makeTempPath(ext) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  return path.join(TEMP_DIR, `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

/**
 * 将临时文件移动到目标路径（跨设备时回退到复制+删除）
 */
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

/**
 * 获取视频元数据（用 ffmpeg -i 解析 stderr，无需 ffprobe）
 *
 * 返回结构与 fluent-ffmpeg ffprobe 保持兼容：
 *   { format: { duration }, streams: [{ codec_type }] }
 */
function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn(ffmpegPath, ['-i', videoPath], { windowsHide: true });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', () => {
      // 解析时长：Duration: HH:MM:SS.ss
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (!durMatch) {
        reject(new Error(`无法解析视频时长: ${path.basename(videoPath)}`));
        return;
      }
      const duration = parseInt(durMatch[1]) * 3600
        + parseInt(durMatch[2]) * 60
        + parseFloat(durMatch[3]);

      // 解析流：找出所有 codec_type（audio/video）
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

/**
 * 提取视频音频为 16kHz 单声道 WAV（供 VAD 分析用）
 * ffmpeg 输出到 ASCII 临时路径，完成后移动到 wavPath
 */
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
        try {
          moveFile(tmpOut, wavPath);
          resolve();
        } catch (e) {
          reject(e);
        }
      })
      .run();
  });
}

// 视频美化滤镜链：皮肤平滑（hqdn3d）+ 提亮美白（eq）+ 轻度模糊（unsharp 负值）
// 同时缩放到 720p 并保持宽高比，不足部分填黑边
const VIDEO_FILTER_CHAIN = [
  'scale=1280:720:force_original_aspect_ratio=decrease',
  'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  'hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5',
  'eq=brightness=0.04:contrast=1.05:saturation=0.9:gamma=0.95',
  'unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=-0.3',
].join(',');

// 音频降噪滤镜链：去低频底噪（highpass）+ FFT 自适应降噪（afftdn）+ 去高频噪声（lowpass）
const AUDIO_FILTER_CHAIN = 'highpass=f=100,afftdn=nr=12:nf=-35:nt=w:track_noise=true,lowpass=f=12000';

/**
 * 掐头去尾剪辑视频，同时应用美化+降噪+720p/24fps/2500kbps 输出规格
 * 所有格式统一重编码（流复制无法改变分辨率/帧率/码率）
 */
function trimVideo(inputPath, outputPath, startTime, endTime, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const PAD = 0.5;
    const actualStart = Math.max(0, startTime - PAD);
    const actualEnd = endTime < 0 ? totalDuration : Math.min(totalDuration, endTime + PAD);
    const duration = actualEnd - actualStart;

    if (duration <= 0) {
      reject(new Error(`剪辑时长无效: start=${actualStart}, end=${actualEnd}`));
      return;
    }

    const tmpOut = makeTempPath('.mp4');

    const cmd = ffmpeg(inputPath)
      .seekInput(actualStart)
      .duration(duration)
      .videoFilters(VIDEO_FILTER_CHAIN)
      .audioFilters(AUDIO_FILTER_CHAIN)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-r', '24',
        '-b:v', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-preset', 'fast',
        '-movflags', '+faststart',
      ])
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
        try {
          moveFile(tmpOut, outputPath);
          resolve();
        } catch (e) {
          reject(e);
        }
      })
      .run();
  });
}

module.exports = { getVideoMetadata, extractAudioWav, trimVideo };
