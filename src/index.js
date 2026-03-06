/**
 * 主程序入口
 *
 * 用法：
 *   node src/index.js <视频文件夹路径>
 *   或将文件夹拖拽到 vadCut.bat 批处理文件
 *
 * 功能：
 *   1. 扫描指定文件夹中的视频文件（mp4/mkv/avi/mov/mts/m2ts/ts/flv/wmv/webm）
 *   2. 在文件夹下创建"剪辑"子文件夹
 *   3. 提取每个视频的音频，用 sherpa-onnx VAD 检测语音边界
 *   4. 根据语音边界掐头去尾，输出剪辑后的视频到"剪辑"子文件夹
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getVideoMetadata, extractAudioWav, trimVideo } = require('./ffmpegUtils');
const { detectSpeechBounds } = require('./vad');

// 支持的视频扩展名
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.mts', '.m2ts', '.ts',
  '.flv', '.wmv', '.webm', '.mpg', '.mpeg', '.m4v',
]);

// 输出子文件夹名称
const OUTPUT_SUBDIR = '剪辑';

// 临时文件目录（系统 temp）
const TEMP_DIR = path.join(os.tmpdir(), 'vad-cut');

/**
 * 格式化秒数为 mm:ss.ms
 */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return `${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
}

/**
 * 扫描文件夹中的视频文件（不递归）
 */
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
 * 处理单个视频文件
 */
async function processVideo(videoPath, outputDir) {
  const basename = path.basename(videoPath);
  const ext = path.extname(videoPath).toLowerCase();
  const nameWithoutExt = path.basename(videoPath, ext);

  // MTS 格式输出为 mp4（兼容性更好），其他格式保持原格式
  const outputExt = ext === '.mts' || ext === '.m2ts' ? '.mp4' : ext;
  const outputPath = path.join(outputDir, nameWithoutExt + outputExt);

  // 如果已存在则跳过
  if (fs.existsSync(outputPath)) {
    console.log(`  [跳过] 已存在: ${path.basename(outputPath)}`);
    return { skipped: true };
  }

  // 临时 WAV 文件
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  const wavPath = path.join(TEMP_DIR, `${nameWithoutExt}_${Date.now()}.wav`);

  try {
    // Step 1: 获取视频时长
    process.stdout.write(`  [1/3] 读取元数据...`);
    const metadata = await getVideoMetadata(videoPath);
    const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
    const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

    if (!audioStream) {
      console.log(' 无音频轨道，跳过');
      return { skipped: true, reason: 'no audio' };
    }

    const totalDuration = parseFloat(metadata.format.duration);
    console.log(` 时长: ${formatTime(totalDuration)}`);

    // Step 2: 提取音频
    process.stdout.write(`  [2/3] 提取音频...`);
    let lastPct = 0;
    await extractAudioWav(videoPath, wavPath, (pct) => {
      if (pct - lastPct >= 20) {
        process.stdout.write(` ${Math.round(pct)}%`);
        lastPct = pct;
      }
    });
    console.log(' 完成');

    // Step 3: VAD 检测
    process.stdout.write(`  [3/3] VAD 语音检测...`);
    const { firstSpeechTime, lastSpeechTime, segments } = detectSpeechBounds(wavPath);
    console.log(
      ` 检测到 ${segments.length} 个语音片段\n` +
      `         语音起始: ${formatTime(firstSpeechTime)}, ` +
      `语音结束: ${formatTime(lastSpeechTime)}`
    );

    // 计算剪切量
    const headCut = Math.max(0, firstSpeechTime - 0.5);
    const tailCut = Math.max(0, totalDuration - lastSpeechTime - 0.5);

    if (headCut < 1.0 && tailCut < 1.0) {
      console.log(`  → 头尾冗余均不足1秒，无需剪辑，复制文件`);
      fs.copyFileSync(videoPath, outputPath);
      return { headCut: 0, tailCut: 0, copied: true };
    }

    console.log(`  → 将剪去开头 ${headCut.toFixed(1)}s，结尾 ${tailCut.toFixed(1)}s`);

    // Step 4: 剪辑视频
    process.stdout.write(`  剪辑中...`);
    lastPct = 0;
    await trimVideo(videoPath, outputPath, firstSpeechTime, lastSpeechTime, totalDuration, (pct) => {
      if (pct - lastPct >= 20) {
        process.stdout.write(` ${Math.round(pct)}%`);
        lastPct = pct;
      }
    });
    console.log(' 完成');
    console.log(`  → 输出: ${path.basename(outputPath)}`);

    return { headCut, tailCut, outputPath };
  } finally {
    // 清理临时 WAV 文件
    if (fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch (_) {}
    }
  }
}

/**
 * 主流程
 */
async function main() {
  // Windows 拖拽文件夹时，路径作为第一个命令行参数传入
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node src/index.js <视频文件夹路径>');
    console.error('      或将文件夹拖拽到 vadCut.bat');
    process.exit(1);
  }

  const folderPath = args[0].replace(/["']/g, '').trim();

  if (!fs.existsSync(folderPath)) {
    console.error(`错误: 文件夹不存在: ${folderPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    console.error(`错误: 指定路径不是文件夹: ${folderPath}`);
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  VAD-Cut 课程视频掐头去尾剪辑工具');
  console.log('═══════════════════════════════════════════════════');
  console.log(`输入文件夹: ${folderPath}`);

  // 扫描视频文件
  const videoFiles = scanVideoFiles(folderPath);
  if (videoFiles.length === 0) {
    console.log('\n未在该文件夹中找到视频文件。');
    console.log(`支持格式: ${[...VIDEO_EXTENSIONS].join(', ')}`);
    process.exit(0);
  }

  console.log(`找到 ${videoFiles.length} 个视频文件`);

  // 创建输出目录
  const outputDir = path.join(folderPath, OUTPUT_SUBDIR);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`已创建输出文件夹: ${outputDir}`);
  } else {
    console.log(`输出文件夹: ${outputDir}`);
  }

  console.log('');

  // 逐个处理视频
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  const results = [];

  for (let i = 0; i < videoFiles.length; i++) {
    const videoPath = videoFiles[i];
    const basename = path.basename(videoPath);
    console.log(`[${i + 1}/${videoFiles.length}] ${basename}`);

    try {
      const result = await processVideo(videoPath, outputDir);
      results.push({ file: basename, ...result });
      if (result.skipped) {
        skipCount++;
      } else {
        successCount++;
      }
    } catch (err) {
      console.error(`  [错误] ${err.message}`);
      errorCount++;
      results.push({ file: basename, error: err.message });
    }

    console.log('');
  }

  // 打印汇总
  console.log('═══════════════════════════════════════════════════');
  console.log('  处理完成');
  console.log('═══════════════════════════════════════════════════');
  console.log(`成功: ${successCount}  跳过: ${skipCount}  错误: ${errorCount}`);
  console.log(`输出目录: ${outputDir}`);

  if (results.some(r => !r.skipped && !r.error && !r.copied)) {
    console.log('\n剪辑详情:');
    for (const r of results) {
      if (!r.skipped && !r.error) {
        if (r.copied) {
          console.log(`  ${r.file} → 直接复制（无需剪辑）`);
        } else {
          console.log(
            `  ${r.file} → 切头 ${r.headCut.toFixed(1)}s, 切尾 ${r.tailCut.toFixed(1)}s`
          );
        }
      }
    }
  }

  if (errorCount > 0) {
    console.log('\n错误详情:');
    for (const r of results) {
      if (r.error) console.log(`  ${r.file}: ${r.error}`);
    }
  }
}

main().catch((err) => {
  console.error('\n程序异常:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
