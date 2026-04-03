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
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { makeTempPath, safeRemoveFile } = require('./audioUtils');
const { ffmpegPath, runFfmpeg } = require('./ffmpegRunner');
const { isCancelledError } = require('./taskCancellation');

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'UNKNOWN') throw e;
  }

  const srcSize = fs.statSync(src).size;

  let copySuccess = false;
  try {
    fs.copyFileSync(src, dest);
    copySuccess = true;
  } catch (_) {
    try {
      const destSize = fs.statSync(dest).size;
      if (destSize === srcSize) copySuccess = true;
    } catch (_) {}
  }

  if (copySuccess) {
    try {
      const destSize = fs.statSync(dest).size;
      if (destSize !== srcSize) {
        throw new Error(`文件大小不匹配: 源=${srcSize}, 目标=${destSize}`);
      }
      const fd = fs.openSync(dest, 'r');
      fs.closeSync(fd);
      safeRemoveFile(src);
      return;
    } catch (_) {
      safeRemoveFile(dest);
    }
  }

  return new Promise((resolve, reject) => {
    const srcStream = fs.createReadStream(src);
    const destStream = fs.createWriteStream(dest);

    destStream.on('finish', () => {
      setTimeout(() => {
        try {
          const destSize = fs.statSync(dest).size;
          if (destSize !== srcSize) {
            throw new Error(`流式复制后大小不匹配: 源=${srcSize}, 目标=${destSize}`);
          }
          const fd = fs.openSync(dest, 'r');
          fs.closeSync(fd);
          safeRemoveFile(src);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 200);
    });

    destStream.on('error', reject);
    srcStream.on('error', reject);
    srcStream.pipe(destStream);
  });
}

function summarizeEncoderFailure(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidate = lines
    .slice()
    .reverse()
    .find((line) => /error|failed|cannot|unavailable|not available/i.test(line));

  return candidate
    ? candidate.replace(/^\[[^\]]+\]\s*/, '')
    : '不可用';
}

function testEncoder(encoder) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=1',
      '-vframes', '1',
      '-c:v', encoder,
      '-f', 'null', '-',
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        delete _encoderDiagnostics[encoder];
      } else {
        _encoderDiagnostics[encoder] = summarizeEncoderFailure(stderr);
      }
      resolve(code === 0);
    });
    proc.on('error', () => {
      _encoderDiagnostics[encoder] = '探测失败';
      resolve(false);
    });
  });
}

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

let _encoderCache = undefined;
const _encoderDiagnostics = {};

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

async function getEncoderInfo() {
  const enc = await detectEncoder();
  if (enc) return `${enc.label} (${enc.encoder})`;

  const diagnostics = GPU_CANDIDATES
    .map((candidate) => {
      const detail = _encoderDiagnostics[candidate.encoder];
      return detail ? `${candidate.label}: ${detail}` : `${candidate.label}: 不可用`;
    })
    .join(' | ');

  return `CPU (libx264) — GPU 不可用: ${diagnostics}`;
}

function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', videoPath], { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', () => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!durationMatch) {
        reject(new Error(`无法解析视频时长: ${path.basename(videoPath)}`));
        return;
      }

      const duration = Number(durationMatch[1]) * 3600
        + Number(durationMatch[2]) * 60
        + Number(durationMatch[3]);

      const streams = [];
      const streamPattern = /Stream #.*?:\s*(Video|Audio|Subtitle):/gi;
      let match;
      while ((match = streamPattern.exec(stderr)) !== null) {
        streams.push({ codec_type: match[1].toLowerCase() });
      }

      resolve({
        format: { duration },
        streams,
      });
    });

    proc.on('error', reject);
  });
}

const VIDEO_FILTER_CHAIN = [
  'scale=1280:720:force_original_aspect_ratio=decrease',
  'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  'hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5',
  'eq=brightness=0.04:contrast=1.05:saturation=0.9:gamma=0.95',
  'unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=-0.3',
].join(',');

const AUDIO_FILTER_CHAIN = 'highpass=f=100,afftdn=nr=12:nf=-35:nt=w:track_noise=true,lowpass=f=12000';

function buildEncodingArgs(gpuEnc) {
  return gpuEnc
    ? [
      '-c:v', gpuEnc.encoder,
      ...gpuEnc.extraOpts,
      '-b:v', '1500k',
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-r', '24',
      '-movflags', '+faststart',
    ]
    : [
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-b:v', '1500k',
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-r', '24',
      '-movflags', '+faststart',
    ];
}

function buildMediaFilterArgs({
  inputPath,
  hasAudio = true,
  startTime = null,
  duration = null,
}) {
  const args = ['-i', inputPath];

  if (Number.isFinite(startTime) && startTime > 0) {
    args.push('-ss', String(startTime));
  }
  if (Number.isFinite(duration) && duration > 0) {
    args.push('-t', String(duration));
  }

  args.push('-vf', VIDEO_FILTER_CHAIN);

  if (hasAudio) {
    args.push(
      '-af', AUDIO_FILTER_CHAIN,
      '-c:a', 'aac',
      '-b:a', '128k'
    );
  } else {
    args.push('-an');
  }

  return args;
}

async function runVideoTransform(
  inputPath,
  outputPath,
  durationSec,
  onProgress,
  options = {}
) {
  const {
    hasAudio = true,
    signal = null,
    startTime = null,
    clipDuration = null,
  } = options;
  const gpuEnc = await detectEncoder();
  const tmpOut = makeTempPath('.mp4');
  const args = [
    ...(gpuEnc ? ['-hwaccel', gpuEnc.hwaccel] : []),
    ...buildMediaFilterArgs({
      inputPath,
      hasAudio,
      startTime,
      duration: clipDuration,
    }),
    ...buildEncodingArgs(gpuEnc),
    '-y',
    tmpOut,
  ];

  try {
    await runFfmpeg(args, {
      signal,
      onProgress,
      durationSec,
    });
    const moved = moveFile(tmpOut, outputPath);
    if (moved && typeof moved.then === 'function') {
      await moved;
    }
  } catch (err) {
    safeRemoveFile(tmpOut);
    if (gpuEnc && !isCancelledError(err)) {
      _encoderCache = null;
      return runVideoTransform(inputPath, outputPath, durationSec, onProgress, options);
    }
    throw err;
  }
}

async function trimVideo(
  inputPath,
  outputPath,
  startTime,
  endTime,
  totalDuration,
  onProgress,
  options = {}
) {
  const PAD = 0.5;
  const actualStart = Math.max(0, startTime - PAD);
  const actualEnd = endTime < 0 ? totalDuration : Math.min(totalDuration, endTime + PAD);
  const duration = actualEnd - actualStart;

  if (duration <= 0) {
    throw new Error(`剪辑时长无效: start=${actualStart}, end=${actualEnd}`);
  }

  return runVideoTransform(inputPath, outputPath, duration, onProgress, {
    ...options,
    hasAudio: true,
    startTime: actualStart,
    clipDuration: duration,
  });
}

async function transcodeVideo(
  inputPath,
  outputPath,
  totalDuration,
  onProgress,
  options = {}
) {
  return runVideoTransform(inputPath, outputPath, totalDuration, onProgress, {
    ...options,
    hasAudio: options.hasAudio !== false,
  });
}

module.exports = {
  detectEncoder,
  getEncoderInfo,
  getVideoMetadata,
  moveFile,
  transcodeVideo,
  trimVideo,
};
