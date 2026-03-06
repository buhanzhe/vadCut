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

// 这些输入格式含有不兼容 MP4 的编解码（AC-3、MPEG-2），必须重新编码
const REENCODE_EXTS = new Set(['.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.vob']);

/**
 * 掐头去尾剪辑视频
 * ffmpeg 输出到 ASCII 临时路径，完成后移动到 outputPath
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

    const inputExt = path.extname(inputPath).toLowerCase();

    // MTS/TS/MPEG 等格式含 AC-3 或 MPEG-2 流，无法 stream copy 进 MP4，直接重新编码
    if (REENCODE_EXTS.has(inputExt)) {
      return trimVideoReencode(inputPath, outputPath, actualStart, duration, onProgress)
        .then(resolve)
        .catch(reject);
    }

    const ext = path.extname(outputPath).toLowerCase();
    const tmpOut = makeTempPath(ext);

    const cmd = ffmpeg(inputPath)
      .seekInput(actualStart)
      .duration(duration)
      .outputOptions([
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-map', '0',
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
        // 任何 stream copy 失败都回退到重新编码
        trimVideoReencode(inputPath, outputPath, actualStart, duration, onProgress)
          .then(resolve)
          .catch(reject);
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

/**
 * 重新编码方式剪辑（兼容性更好，但速度较慢）
 */
function trimVideoReencode(inputPath, outputPath, startTime, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(outputPath).toLowerCase();
    const tmpOut = makeTempPath(ext);

    const cmd = ffmpeg(inputPath)
      .seekInput(startTime)
      .duration(duration)
      .videoCodec('libx264')
      .videoBitrate('4000k')
      .audioCodec('aac')
      .audioBitrate('192k')
      .outputOptions([
        '-preset', 'fast',
        '-crf', '18',
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
