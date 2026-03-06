# VAD-Cut — 课程视频掐头去尾剪辑工具

基于 **sherpa-onnx** VAD（语音活动检测）的纯本地视频剪辑工具，自动识别视频中第一句话和最后一句话的时间点，精准去除多余的开头和结尾静默/噪声片段。

## 功能特性

- **纯本地处理**：无需联网，所有计算在本机完成
- **拖拽操作**：将视频文件夹直接拖到 `vadCut.bat`，自动批量处理
- **智能边界检测**：使用 Silero-VAD 模型精准识别语音起止时间
- **无损剪辑**：默认使用 FFmpeg 流拷贝，速度快且画质无损
- **多格式支持**：mp4 / mkv / avi / mov / **MTS** / m2ts / ts / flv / wmv / webm
- **自动创建输出目录**：在输入文件夹下自动创建 `剪辑/` 子文件夹
- **断点续传**：已处理的文件自动跳过

## 系统要求

- **Windows 10/11**（64位）
- **Node.js 18+**

## 安装与初始化

### 1. 安装 Node.js

下载并安装 [Node.js 18 LTS](https://nodejs.org/en/download/)

### 2. 安装依赖 & 下载模型

双击运行 `vadCut.bat`（首次运行会自动完成），或手动执行：

```bash
npm install
npm run setup
```

`npm run setup` 会从 GitHub Releases 下载 `silero_vad.onnx` 模型文件（约 ~1.7MB）到 `models/` 目录。

## 使用方法

### 拖拽方式（推荐）

将包含视频文件的文件夹拖拽到 `vadCut.bat` 图标上即可。

### 命令行方式

```bash
node src/index.js "D:\课程视频\第一章"
```

### 输出结果

程序会在输入文件夹下创建 `剪辑/` 子文件夹，处理后的视频保存在其中：

```
D:\课程视频\第一章\
├── 01-介绍.mts          ← 原始文件
├── 02-安装.mts
├── 03-配置.mts
└── 剪辑\
    ├── 01-介绍.mp4      ← 剪辑后（MTS → MP4）
    ├── 02-安装.mp4
    └── 03-配置.mp4
```

> MTS/M2TS 格式自动转换为 MP4 输出；其他格式保持原始容器格式。

## 处理流程

```
输入视频
    ↓
[1/3] 读取元数据（时长、轨道信息）
    ↓
[2/3] FFmpeg 提取音频 → 16kHz 单声道 WAV（临时文件）
    ↓
[3/3] sherpa-onnx Silero-VAD 检测语音边界
        → 找到第一个语音片段开始时间
        → 找到最后一个语音片段结束时间
    ↓
FFmpeg 流拷贝剪辑（前后各保留 0.5s 缓冲）
    ↓
输出到 剪辑/ 文件夹
```

## 配置调优

编辑 `src/vad.js` 中的 VAD 参数：

```js
const config = {
  sileroVad: {
    threshold: 0.4,           // 语音概率阈值（越低越灵敏）
    minSilenceDuration: 0.3,  // 最小静音间隔（秒）
    minSpeechDuration: 0.25,  // 最短有效语音长度（秒）
    maxSpeechDuration: 30.0,  // 单段最大语音长度（秒）
    windowSize: 512,          // 窗口大小（16kHz下32ms）
  },
  ...
};
```

编辑 `src/index.js` 中的 `PAD` 常量（默认 0.5 秒）调整边界缓冲时间。

## 项目结构

```
vadCut/
├── src/
│   ├── index.js        # 主程序入口
│   ├── vad.js          # VAD 语音检测模块
│   └── ffmpegUtils.js  # FFmpeg 操作封装
├── scripts/
│   └── download-model.js  # 模型下载脚本
├── models/
│   └── silero_vad.onnx    # VAD 模型（运行 npm run setup 下载）
├── package.json
├── vadCut.bat          # Windows 拖拽启动脚本
└── README.md
```

## 依赖说明

| 包 | 用途 |
|---|---|
| `sherpa-onnx` | Silero-VAD 语音活动检测 |
| `fluent-ffmpeg` | FFmpeg Node.js 封装 |
| `ffmpeg-static` | 内置 FFmpeg 二进制（无需手动安装） |
| `ffprobe-static` | 内置 FFprobe 二进制 |

## 常见问题

**Q: 首次运行很慢？**
A: 第一次运行会安装 npm 依赖（包含 ffmpeg-static ~40MB），之后运行速度正常。

**Q: 模型下载失败？**
A: 可手动下载 `silero_vad.onnx` 并放入 `models/` 目录：
https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

**Q: MTS 文件无法处理？**
A: 确保文件未损坏。程序在流拷贝失败时会自动回退到重新编码模式。

**Q: 剪辑位置不准确？**
A: 调低 `threshold`（如 0.3）使检测更灵敏，或增大 `PAD` 缓冲时间。
