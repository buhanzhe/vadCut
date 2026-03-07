# VAD-Cut

课程视频**掐头去尾**剪辑工具。自动检测视频中第一句话和最后一句话的位置，裁掉多余的静默片段，并可选生成 SRT 字幕文件。

---

## 功能

- **自动剪辑**：通过 Silero VAD 定位第一个/最后一个语音片段，自动去掉头尾静默
- **批量处理**：一次选择整个文件夹，最多 4 路并发
- **智能编码**：自动探测 NVIDIA NVENC / AMD AMF / Intel QSV，不可用时回退 CPU (libx264)
- **画质优化**：缩放至 720p / 24fps，降噪 + 色彩均衡，统一输出 MP4 2500kbps
- **字幕生成**（可选）：基于 sherpa-onnx WASM + SenseVoice，识别中英日韩粤，生成 `.srt`
- **主题切换**：标题栏单击按钮在深色 / 浅色主题间切换

## 支持格式

输入：`.mp4` `.mkv` `.avi` `.mov` `.mts` `.m2ts` `.ts` `.flv` `.wmv` `.webm` `.mpg` `.mpeg` `.m4v`

输出：`.mp4`

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 下载 VAD 模型（silero_vad.onnx，约 2 MB）
npm run setup

# 3. 运行
npm start
```

### 字幕功能（可选）

下载并解压 sherpa-onnx WASM 包到 `models/`：

```
models/sherpa-onnx-wasm-simd-1.12.28-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small/
```

下载地址：https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.12.28

---

## 使用方法

1. 点击中央区域，选择包含视频文件的文件夹
2. 根据需要勾选「生成字幕」
3. 点击「开始剪辑」
4. 完成后，剪辑结果在原文件夹下的 `剪辑/` 子目录

```
课程录屏/
├── 01.mts
├── 02.mts
└── 剪辑/
    ├── 01.mp4   ← 已去头尾 + 降噪 + 720p
    └── 02.mp4
```

---

## 打包

```bash
npm run build
```

输出到 `dist/`（Windows ZIP，解压即用）。

---

## 项目结构

```
electron/        主进程与 preload
renderer/        前端页面（HTML / CSS / JS）
src/
  ffmpegUtils.js ffmpeg 封装（编码器探测、剪辑、音频提取）
  vad.js         sherpa-onnx 原生 VAD（语音边界检测）
  asr.js         sherpa-onnx WASM ASR（字幕生成）
  processor.js   核心处理逻辑（扫描、并发调度）
scripts/
  download-model.js  下载 VAD 模型
  gen-icon.js        生成桌面图标
models/          模型文件（不含在仓库中）
build/           图标与打包资源
```

## 技术栈

- [Electron](https://www.electronjs.org/) — 桌面应用框架
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) + [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — 视频处理
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — 原生 VAD（Silero）
- sherpa-onnx WASM — VAD + SenseVoice 字幕识别
