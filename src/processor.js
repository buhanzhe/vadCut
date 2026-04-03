/**
 * 核心处理逻辑模块（供 Electron 主进程和 CLI 共用）
 *
 * 通过回调函数上报进度，适配 IPC 通信或命令行输出
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { extractAudioToTempWav, safeRemoveFile } = require('./audioUtils');
const { formatElapsed, runBatch } = require('./batchRunner');
const { getVideoMetadata, trimVideo, transcodeVideo, getEncoderInfo } = require('./ffmpegUtils');
const { transcribeVideo } = require('./asr');
const { resolveSubtitleSchemeInfo } = require('./asrEngine');
const { detectSpeechBounds } = require('./vad');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.mts', '.m2ts', '.ts',
  '.flv', '.wmv', '.webm', '.mpg', '.mpeg', '.m4v',
]);

const OUTPUT_SUBDIR = '剪辑';
const OUTPUT_TRANSCODE_SUBDIR = '转码';
const MAX_CONCURRENCY = 4;

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return `${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
}

function scanVideoFiles(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      return VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    })
    .map((entry) => path.join(folderPath, entry.name));
}

async function processSubtitleFile(videoPath, callbacks = {}, options = {}) {
  const { onLog = () => {}, onStage = () => {} } = callbacks;
  const signal = options.signal || null;
  const startedAt = Date.now();
  const subtitleScheme = resolveSubtitleSchemeInfo(options.subtitleScheme);
  const srtPath = videoPath.replace(/\.[^.]+$/, '.srt');

  if (fs.existsSync(srtPath)) {
    onLog('已跳过（字幕文件已存在）');
    return {
      skipped: true,
      subtitleOnly: true,
      reason: 'subtitle exists',
      subtitleSchemeId: subtitleScheme.schemeId,
      subtitleSchemeLabel: subtitleScheme.label,
    };
  }

  onLog('提取字幕中...');
  onStage('asr', 0);
  const generatedSrtPath = await transcribeVideo(
    videoPath,
    {
      schemeId: subtitleScheme.schemeId,
      signal,
    },
    (msg) => onLog(msg)
  );
  onStage('asr', 100);
  onLog(`耗时: ${formatElapsed(Date.now() - startedAt)}`);

  if (!generatedSrtPath) {
    return {
      skipped: true,
      subtitleOnly: true,
      reason: 'empty subtitle',
      elapsed: Date.now() - startedAt,
      subtitleSchemeId: subtitleScheme.schemeId,
      subtitleSchemeLabel: subtitleScheme.label,
    };
  }

  return {
    subtitleOnly: true,
    srtPath: generatedSrtPath,
    elapsed: Date.now() - startedAt,
    subtitleSchemeId: subtitleScheme.schemeId,
    subtitleSchemeLabel: subtitleScheme.label,
  };
}

async function processTranscodeFile(videoPath, outputDir, callbacks = {}, options = {}) {
  const { onLog = () => {}, onStage = () => {} } = callbacks;
  const signal = options.signal || null;
  const startedAt = Date.now();
  const extRaw = path.extname(videoPath);
  const nameWithoutExt = path.basename(videoPath, extRaw);
  const outputPath = path.join(outputDir, `${nameWithoutExt}.mp4`);

  if (fs.existsSync(outputPath)) {
    onLog('已跳过（输出文件已存在）');
    return { skipped: true, transcodeOnly: true };
  }

  onLog('读取视频元数据...');
  onStage('metadata', 0);
  const metadata = await getVideoMetadata(videoPath);
  const totalDuration = Number(metadata.format.duration);
  const hasAudio = metadata.streams.some((stream) => stream.codec_type === 'audio');
  onLog(`时长: ${formatTime(totalDuration)}`);
  onStage('metadata', 100);

  if (!hasAudio) {
    onLog('未检测到音频轨道，将仅转码视频画面');
  }

  onLog(`编码器: ${await getEncoderInfo()}`);
  onLog('转码中...');
  onStage('transcode', 0);
  await transcodeVideo(videoPath, outputPath, totalDuration, (pct) => onStage('transcode', pct), {
    signal,
    hasAudio,
  });
  onStage('transcode', 100);
  onLog(`输出: ${path.basename(outputPath)}`);
  onLog(`耗时: ${formatElapsed(Date.now() - startedAt)}`);

  return {
    transcodeOnly: true,
    outputPath,
    totalDuration,
    elapsed: Date.now() - startedAt,
  };
}

async function processClipFile(videoPath, outputDir, callbacks = {}, options = {}) {
  const { onLog = () => {}, onStage = () => {} } = callbacks;
  const signal = options.signal || null;
  const startedAt = Date.now();
  const extRaw = path.extname(videoPath);
  const nameWithoutExt = path.basename(videoPath, extRaw);
  const outputPath = path.join(outputDir, `${nameWithoutExt}.mp4`);
  let wavPath = null;

  if (fs.existsSync(outputPath)) {
    onLog('已跳过（输出文件已存在）');
    return { skipped: true };
  }

  try {
    onLog('读取视频元数据...');
    onStage('metadata', 0);
    const metadata = await getVideoMetadata(videoPath);
    const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio');

    if (!audioStream) {
      onLog('无音频轨道，跳过');
      return { skipped: true, reason: 'no audio' };
    }

    const totalDuration = Number(metadata.format.duration);
    onLog(`时长: ${formatTime(totalDuration)}`);
    onStage('metadata', 100);

    onLog('提取音频（16kHz WAV）...');
    onStage('audio', 0);
    wavPath = await extractAudioToTempWav(videoPath, {
      signal,
      durationSec: totalDuration,
      onProgress: (pct) => onStage('audio', pct),
    });
    onStage('audio', 100);
    onLog('音频提取完成');

    onLog('VAD 语音边界检测...');
    onStage('vad', 0);
    const {
      firstSpeechTime,
      lastSpeechTime,
      segments,
      effectiveSegments,
      ignoredLeadingSegments,
      ignoredTrailingSegments,
      minEdgeSpeechDuration,
      edgeFilterFallback,
    } = detectSpeechBounds(wavPath, {
      minEdgeSpeechDuration: 1.0,
      edgeMergeGapSec: 0.3,
      signal,
    });
    onStage('vad', 100);
    onLog(`检测到 ${segments.length} 个语音片段`);

    const edgeMinLabel = Number(minEdgeSpeechDuration).toFixed(1).replace(/\.0$/, '');
    if (edgeFilterFallback) {
      onLog(`首尾过滤(<${edgeMinLabel}s)后无有效片段，已回退到原始语音边界`);
    } else if (ignoredLeadingSegments > 0 || ignoredTrailingSegments > 0) {
      onLog(`首尾过滤(<${edgeMinLabel}s)：忽略开头 ${ignoredLeadingSegments} 个、结尾 ${ignoredTrailingSegments} 个片段`);
    }
    if (effectiveSegments.length !== segments.length) {
      onLog(`用于剪辑边界的语音片段: ${effectiveSegments.length} 个`);
    }
    onLog(`语音起始: ${formatTime(firstSpeechTime)}  结束: ${formatTime(lastSpeechTime)}`);

    const headCut = Math.max(0, firstSpeechTime - 0.5);
    const tailCut = Math.max(0, totalDuration - lastSpeechTime - 0.5);

    if (headCut < 1.0 && tailCut < 1.0) {
      onLog('头尾冗余均不足1秒，仅转码美化');
    } else {
      onLog(`将剪去开头 ${headCut.toFixed(1)}s，结尾 ${tailCut.toFixed(1)}s`);
    }

    onLog(`编码器: ${await getEncoderInfo()}`);
    onLog('剪辑中...');
    onStage('trim', 0);
    await trimVideo(
      videoPath,
      outputPath,
      firstSpeechTime,
      lastSpeechTime,
      totalDuration,
      (pct) => onStage('trim', pct),
      { signal }
    );
    onStage('trim', 100);
    onLog(`输出: ${path.basename(outputPath)}`);

    if (options.generateSubtitle) {
      onStage('asr', 0);
      try {
        await transcribeVideo(
          outputPath,
          {
            signal,
            ...(options.subtitleScheme ? { schemeId: options.subtitleScheme } : {}),
          },
          (msg) => onLog(msg)
        );
      } catch (asrErr) {
        onLog(`ASR 跳过: ${asrErr.message}`);
      }
      onStage('asr', 100);
    }

    onLog(`耗时: ${formatElapsed(Date.now() - startedAt)}`);
    return {
      headCut,
      tailCut,
      outputPath,
      totalDuration,
      firstSpeechTime,
      lastSpeechTime,
      elapsed: Date.now() - startedAt,
    };
  } finally {
    safeRemoveFile(wavPath);
  }
}

async function processVideo(videoPath, outputDir, callbacks = {}, options = {}) {
  if (options.subtitleOnly) {
    return processSubtitleFile(videoPath, callbacks, options);
  }

  if (options.transcodeOnly) {
    return processTranscodeFile(videoPath, outputDir, callbacks, options);
  }

  return processClipFile(videoPath, outputDir, callbacks, options);
}

async function processFolder(folderPath, callbacks = {}, signal = { cancelled: false }, options = {}) {
  const {
    onScan = () => {},
    onFileStart = () => {},
    onFileLog = () => {},
    onFileStage = () => {},
    onFileDone = () => {},
    onFileError = () => {},
    onAllDone = () => {},
  } = callbacks;

  const videoFiles = scanVideoFiles(folderPath);
  onScan(videoFiles);

  if (videoFiles.length === 0) {
    onAllDone({ total: 0, success: 0, skipped: 0, errors: 0 });
    return;
  }

  const outputDir = options.subtitleOnly
    ? folderPath
    : path.join(folderPath, options.transcodeOnly ? OUTPUT_TRANSCODE_SUBDIR : OUTPUT_SUBDIR);
  const subtitleScheme = resolveSubtitleSchemeInfo(options.subtitleScheme);
  if (!options.subtitleOnly && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const concurrency = Math.min(MAX_CONCURRENCY, videoFiles.length);
  onFileLog(-1, `并发数: ${concurrency}`);
  if (options.subtitleOnly) {
    onFileLog(-1, `字幕方案: ${subtitleScheme.label}`);
  } else if (options.transcodeOnly) {
    onFileLog(-1, '模式: 仅转码');
  }

  const summary = await runBatch({
    files: videoFiles,
    concurrency,
    signal,
    onFileStart,
    onFileDone,
    onFileError,
    onFileLog,
    runFile: ({ index, filePath }) => processVideo(
      filePath,
      outputDir,
      {
        onLog: (msg) => onFileLog(index, msg),
        onStage: (stage, pct) => onFileStage(index, stage, pct),
      },
      { ...options, signal }
    ),
  });

  onAllDone({
    ...summary,
    outputDir,
    subtitleSchemeId: options.subtitleOnly ? subtitleScheme.schemeId : null,
    subtitleSchemeLabel: options.subtitleOnly ? subtitleScheme.label : null,
  });
}

module.exports = {
  OUTPUT_SUBDIR,
  OUTPUT_TRANSCODE_SUBDIR,
  VIDEO_EXTENSIONS,
  processFolder,
  processVideo,
  scanVideoFiles,
};
