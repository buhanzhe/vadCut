/**
 * 核心处理逻辑模块（供 Electron 主进程和 CLI 共用）
 *
 * 通过回调函数上报进度，适配 IPC 通信或命令行输出
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getVideoMetadata, extractAudioWav, trimVideo } = require('./ffmpegUtils');
const { detectSpeechBounds } = require('./vad');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.mts', '.m2ts', '.ts',
  '.flv', '.wmv', '.webm', '.mpg', '.mpeg', '.m4v',
]);

const OUTPUT_SUBDIR = '剪辑';
const TEMP_DIR = path.join(os.tmpdir(), 'vad-cut');

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return `${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
}

/** 将毫秒格式化为易读的耗时字符串，如 "1分23秒" 或 "45秒" */
function formatElapsed(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}秒`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}分${s}秒`;
}

function scanVideoFiles(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return entries
    .filter((e) => {
      if (!e.isFile()) return false;
      const ext = path.extname(e.name).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    })
    .map((e) => path.join(folderPath, e.name));
}

/**
 * 处理单个视频
 * @param {string} videoPath
 * @param {string} outputDir
 * @param {object} callbacks
 *   onLog(msg)           - 日志文本
 *   onStage(stage, pct)  - 当前阶段与进度 (0-100)
 * @returns {Promise<object>} result
 */
async function processVideo(videoPath, outputDir, callbacks = {}) {
  const { onLog = () => {}, onStage = () => {} } = callbacks;
  const t0 = Date.now();

  const extRaw = path.extname(videoPath);           // 保留原始大小写，用于剥离
  const nameWithoutExt = path.basename(videoPath, extRaw);  // 用原始大小写剥离，避免 00108.MTS → 00108.MTS.mp4
  const outputExt = '.mp4'; // 统一输出 MP4（重编码+美化+降噪需要）
  const outputPath = path.join(outputDir, nameWithoutExt + outputExt);

  if (fs.existsSync(outputPath)) {
    onLog(`已跳过（输出文件已存在）`);
    return { skipped: true };
  }

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  // 临时 WAV 必须用纯 ASCII 路径（ffmpeg-static 在 Windows 下的限制）
  const wavPath = path.join(TEMP_DIR, `audio_${Date.now()}.wav`);

  try {
    // 1. 元数据
    onLog('读取视频元数据...');
    onStage('metadata', 0);
    const metadata = await getVideoMetadata(videoPath);
    const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

    if (!audioStream) {
      onLog('无音频轨道，跳过');
      return { skipped: true, reason: 'no audio' };
    }

    const totalDuration = parseFloat(metadata.format.duration);
    onLog(`时长: ${formatTime(totalDuration)}`);
    onStage('metadata', 100);

    // 2. 提取音频
    onLog('提取音频（16kHz WAV）...');
    onStage('audio', 0);
    await extractAudioWav(videoPath, wavPath, (pct) => onStage('audio', pct));
    onStage('audio', 100);
    onLog('音频提取完成');

    // 3. VAD
    onLog('VAD 语音边界检测...');
    onStage('vad', 0);
    const { firstSpeechTime, lastSpeechTime, segments } = detectSpeechBounds(wavPath);
    onStage('vad', 100);
    onLog(`检测到 ${segments.length} 个语音片段`);
    onLog(`语音起始: ${formatTime(firstSpeechTime)}  结束: ${formatTime(lastSpeechTime)}`);

    const headCut = Math.max(0, firstSpeechTime - 0.5);
    const tailCut = Math.max(0, totalDuration - lastSpeechTime - 0.5);

    if (headCut < 1.0 && tailCut < 1.0) {
      onLog('头尾冗余均不足1秒，仅转码美化');
    } else {
      onLog(`将剪去开头 ${headCut.toFixed(1)}s，结尾 ${tailCut.toFixed(1)}s`);
    }

    // 4. 剪辑
    onLog('剪辑中...');
    onStage('trim', 0);
    await trimVideo(videoPath, outputPath, firstSpeechTime, lastSpeechTime, totalDuration,
      (pct) => onStage('trim', pct));
    onStage('trim', 100);
    onLog(`输出: ${path.basename(outputPath)}`);
    onLog(`耗时: ${formatElapsed(Date.now() - t0)}`);

    return { headCut, tailCut, outputPath, totalDuration, firstSpeechTime, lastSpeechTime, elapsed: Date.now() - t0 };

  } finally {
    if (fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch (_) {}
    }
  }
}

/**
 * 处理整个文件夹
 * @param {string} folderPath
 * @param {object} callbacks
 *   onScan(files)                     - 扫描结果 [filePath, ...]
 *   onFileStart(index, filePath)       - 开始处理某文件
 *   onFileLog(index, msg)              - 文件日志
 *   onFileStage(index, stage, pct)     - 文件当前阶段进度
 *   onFileDone(index, result)          - 文件完成
 *   onFileError(index, errMsg)         - 文件出错
 *   onAllDone(summary)                 - 全部完成
 * @param {object} [signal]  { cancelled: boolean }
 */
async function processFolder(folderPath, callbacks = {}, signal = { cancelled: false }) {
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

  const outputDir = path.join(folderPath, OUTPUT_SUBDIR);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let success = 0, skipped = 0, errors = 0;
  const timings = []; // { name, elapsed }
  const folderStart = Date.now();

  for (let i = 0; i < videoFiles.length; i++) {
    if (signal.cancelled) break;

    const videoPath = videoFiles[i];
    onFileStart(i, videoPath);

    try {
      const result = await processVideo(videoPath, outputDir, {
        onLog: (msg) => onFileLog(i, msg),
        onStage: (stage, pct) => onFileStage(i, stage, pct),
      });
      onFileDone(i, result);
      if (result.skipped) {
        skipped++;
      } else {
        success++;
        if (result.elapsed) {
          timings.push({ name: path.basename(videoPath), elapsed: result.elapsed });
        }
      }
    } catch (err) {
      onFileError(i, err.message);
      errors++;
    }
  }

  const totalElapsed = Date.now() - folderStart;

  // 在日志里输出耗时汇总
  if (timings.length > 0) {
    const lines = [`── 耗时汇总 ─────────────────────`];
    for (const t of timings) {
      lines.push(`  ${t.name}: ${formatElapsed(t.elapsed)}`);
    }
    lines.push(`  合计: ${formatElapsed(totalElapsed)}（共 ${timings.length} 个文件）`);
    lines.push('──────────────────────────────────');
    // 通过最后一个文件的 onFileLog 或 onAllDone 带出；这里统一用 index=-1 约定为全局日志
    for (const l of lines) onFileLog(-1, l);
  }

  onAllDone({ total: videoFiles.length, success, skipped, errors, outputDir, totalElapsed });
}

module.exports = { processFolder, processVideo, scanVideoFiles, OUTPUT_SUBDIR, VIDEO_EXTENSIONS };
