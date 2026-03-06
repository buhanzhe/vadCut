# VAD-Cut — 课程视频掐头去尾剪辑工具

基于 **sherpa-onnx Silero-VAD** 的纯本地 Electron 桌面应用，自动识别视频中第一句话和最后一句话的时间点，批量去除多余的开头/结尾静默片段，同时对画面进行美化、对音频进行降噪，统一输出为 MP4 720p 24fps CBR 2500kbps 规格。

---

## 功能特性

- **纯本地处理**：无需联网，所有 AI 推理和视频处理均在本机完成
- **拖拽操作**：将文件夹拖拽到窗口任意位置即可加载；也可点击选择
- **智能边界检测**：Silero-VAD 模型精准识别语音起止时间，前后保留 0.5s 缓冲
- **视频美化**：画面去噪（hqdn3d）+ 提亮美白（eq）+ 轻微柔焦（unsharp 负值）
- **音频降噪**：FFT 自适应降噪（afftdn）+ 高/低通滤波
- **GPU 加速**：自动探测 NVIDIA NVENC / AMD AMF / Intel QSV，不可用时降级 CPU
- **自适应并发**：GPU 模式 3 路并发，CPU 模式按核心数动态调节
- **断点续传**：输出文件已存在时自动跳过
- **多格式支持**：mp4 / mkv / avi / mov / MTS / m2ts / ts / flv / wmv / webm / mpg / m4v

---

## 系统要求

- **Windows 10/11**（64 位）
- **Node.js 18+**
- **NVIDIA GPU（可选）**：需安装 CUDA 运行时（CUDA Runtime）

---

## 安装与初始化

### 1. 克隆或解压项目

```
vadCut/
```

### 2. 安装依赖

```bash
npm install
```

### 3. 下载 VAD 模型

```bash
npm run setup
```

从 GitHub Releases 下载 `silero_vad.onnx`（约 1.7 MB）到 `models/` 目录。

> 如网络受限，可手动下载后放入 `models/silero_vad.onnx`：
> `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`

### 4. 启动应用

```bash
npm start
```

---

## 打包发布（Windows ZIP）

```bash
npm run build
```

输出在 `dist/VAD-Cut-*.zip`，解压即用，无需安装 Node.js。

打包配置见 [electron-builder.json](electron-builder.json)。

---

## 使用方法

1. 启动应用后，将包含视频文件的**文件夹**拖拽到窗口，或点击窗口选择文件夹
2. 点击 **开始处理**
3. 处理完成后，输出文件在原文件夹的 `剪辑/` 子目录

```
D:\课程录屏\第一章\
├── 01-介绍.mts
├── 02-安装.mts
└── 剪辑\
    ├── 01-介绍.mp4      ← 美化 + 降噪 + 720p 24fps 2500kbps
    └── 02-安装.mp4
```

处理中途可点击 **取消** 停止，已完成的文件不受影响。

---

## 处理流程

```
输入视频
    ↓
[元数据] ffmpeg -i 解析时长与轨道信息（stderr 正则匹配）
    ↓
[提取音频] FFmpeg → 16kHz 单声道 PCM WAV → 系统临时目录
    ↓
[VAD 检测] sherpa-onnx Silero-VAD
           512 样本（32ms）分块送入 → 收集语音片段列表
           → 取首段 start 为 firstSpeechTime
           → 取末段 end   为 lastSpeechTime
    ↓
[剪辑编码] FFmpeg 从 (firstSpeechTime - 0.5s) 剪到 (lastSpeechTime + 0.5s)
           视频滤镜链 → 音频滤镜链 → GPU/CPU 编码 → 输出临时 MP4
    ↓
[移动文件] fs.renameSync（跨分区时 copyFileSync + unlinkSync）
    ↓
输出到 剪辑/ 文件夹
```

---

## 技术方案

### VAD — 语音活动检测

| 项 | 值 |
|---|---|
| 引擎 | `sherpa-onnx` Node.js 绑定 |
| 模型 | Silero-VAD v4 (`silero_vad.onnx`) |
| 采样率 | 16 kHz 单声道 |
| 窗口大小 | 512 samples（32ms） |
| 阈值 | 0.4（概率超过此值判定为语音） |
| 最小静音间隔 | 0.3s |
| 最短有效语音 | 0.25s |
| 最长单段语音 | 30s |
| 运行方式 | 同步（Node.js 主线程，sherpa-onnx 内部多线程=1） |

WAV 文件由 `readWavSamples()` 手动解析 RIFF 头，读取 PCM int16 → Float32 归一化，无需第三方 WAV 库。

### 元数据解析

不使用 ffprobe，改为 `spawn(ffmpeg, ['-i', videoPath])` 解析 stderr：

```
Duration: HH:MM:SS.ms  → 总时长（秒）
Stream #N:M: Audio      → 判断是否有音轨
```

### 视频滤镜链

```
scale=1280:720:force_original_aspect_ratio=decrease
pad=1280:720:(ow-iw)/2:(oh-ih)/2
hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5
eq=brightness=0.04:contrast=1.05:saturation=0.9:gamma=0.95
unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=-0.3
```

| 滤镜 | 参数说明 |
|---|---|
| `scale+pad` | 缩放到 1280×720，保持原始宽高比，不足处填黑边 |
| `hqdn3d` | 时域空域降噪（磨皮），减少皮肤噪点 |
| `eq` | 提亮 +0.04、微增对比 +1.05、降饱和 0.9、微降 gamma（美白效果） |
| `unsharp` | 负值 `-0.3` 轻度软化，消除高频噪点 |

### 音频滤镜链

```
highpass=f=100,afftdn=nr=12:nf=-35:nt=w:track_noise=true,lowpass=f=12000
```

| 滤镜 | 作用 |
|---|---|
| `highpass=f=100` | 去除 100Hz 以下低频底噪（空调/机械嗡声） |
| `afftdn` | FFT 自适应降噪，降噪强度 12dB，噪声基准 -35dB，自动追踪噪声轮廓 |
| `lowpass=f=12000` | 去除 12kHz 以上高频噪声 |

### 输出规格

| 参数 | 值 |
|---|---|
| 容器 | MP4 |
| 分辨率 | 1280×720（保持宽高比加黑边） |
| 帧率 | 24fps |
| 视频编码 | h264（GPU: NVENC/AMF/QSV CBR；CPU: libx264 CBR） |
| 视频码率 | 2500kbps（CBR，maxrate=2500k，bufsize=5000k） |
| 音频编码 | AAC 128kbps |
| Fast Start | `-movflags +faststart`（moov atom 移到文件头，支持在线播放） |

### GPU 加速

启动时依次探测（`testEncoder`：生成 1 帧黑色视频，exit code 0 为可用）：

| 优先级 | 编码器 | 解码加速 | 额外选项 |
|---|---|---|---|
| 1 | `h264_nvenc`（NVIDIA） | `-hwaccel cuda` | `-rc cbr -preset p4 -spatial-aq 1` |
| 2 | `h264_amf`（AMD） | `-hwaccel d3d11va` | `-rc cbr -quality balanced` |
| 3 | `h264_qsv`（Intel） | `-hwaccel qsv` | `-preset medium -look_ahead 0` |
| 降级 | `libx264`（CPU） | — | `-preset fast` |

GPU 编码失败（如编码过程中崩溃）时，自动重置缓存 → 本次及后续文件降级 CPU 重试。

> **RTX 5060 Ti / Blackwell 系列**：确保已安装 NVIDIA 驱动 ≥ 566.x 及 CUDA Runtime 12.x。
> 日志中的"编码器"行会显示 GPU 选择结果及失败原因，便于诊断。

### 并发控制

```js
GPU 编码 → 并发 3
CPU 编码 → max(1, min(3, floor(cpuCount / 4)))
```

使用信号量模式（`running` 计数器 + `tryStart()` 递归）实现，无需外部库。

### 非 ASCII 路径兼容

`ffmpeg-static` Windows 预编译版不支持含非 ASCII 字符的输出路径（CJK 文件夹名会导致 ffmpeg 报错）。

解决方案：所有 ffmpeg 输出先写入系统临时目录（`%TEMP%\vad-cut\tmp_<timestamp>_<random>.<ext>`，纯 ASCII 路径），处理完成后 `fs.renameSync` 移动到目标路径。跨分区时（EXDEV 错误）退化为 `copyFileSync` + `unlinkSync`。

---

## 项目结构

```
vadCut/
├── electron/
│   ├── main.js         # Electron 主进程（IPC 路由、窗口管理）
│   └── preload.js      # contextBridge 暴露给渲染进程的 API
├── renderer/
│   ├── index.html      # 渲染进程入口
│   ├── app.js          # 渲染进程逻辑（状态管理、IPC 事件、UI 渲染）
│   └── style.css       # 深色主题 UI 样式
├── src/
│   ├── processor.js    # 核心处理逻辑（文件夹扫描、并发调度）
│   ├── vad.js          # VAD 语音检测（sherpa-onnx 封装）
│   └── ffmpegUtils.js  # FFmpeg 操作（元数据、音频提取、剪辑编码）
├── scripts/
│   └── download-model.js  # VAD 模型下载脚本
├── models/
│   └── silero_vad.onnx    # VAD 模型（npm run setup 下载）
├── build/
│   └── icon.ico           # 应用图标
├── electron-builder.json  # 打包配置（asar + asarUnpack + ZIP）
└── package.json
```

---

## 依赖说明

| 包 | 版本 | 用途 |
|---|---|---|
| `electron` | ^33 | 桌面应用框架（devDep） |
| `sherpa-onnx` | ^1.10 | Silero-VAD 推理（Node.js 原生绑定） |
| `ffmpeg-static` | ^5.2 | 内置 FFmpeg Windows 可执行文件（含 NVENC/AMF/QSV） |
| `fluent-ffmpeg` | ^2.1 | FFmpeg 命令构建与进度回调 |

---

## IPC 通信

渲染进程通过 `window.vadCut.*`（contextBridge 暴露）与主进程通信：

| 方法 / 事件 | 方向 | 说明 |
|---|---|---|
| `vadCut.openFolder()` | R→M | 打开系统文件夹选择对话框 |
| `vadCut.shellOpenFolder(path)` | R→M | 用资源管理器打开目录 |
| `vadCut.startProcess(folderPath)` | R→M | 开始批量处理 |
| `vadCut.cancelProcess()` | R→M | 取消处理（设置信号量） |
| `vadCut.on('process:scan', cb)` | M→R | 文件扫描结果 `[filePath, ...]` |
| `vadCut.on('process:fileStart', cb)` | M→R | 开始处理某文件 `{index, filePath}` |
| `vadCut.on('process:fileLog', cb)` | M→R | 文件日志 `{index, msg}`（index=-1 为全局日志） |
| `vadCut.on('process:fileStage', cb)` | M→R | 阶段进度 `{index, stage, pct}` |
| `vadCut.on('process:fileDone', cb)` | M→R | 文件完成 `{index, result}` |
| `vadCut.on('process:fileError', cb)` | M→R | 文件出错 `{index, errMsg}` |
| `vadCut.on('process:allDone', cb)` | M→R | 全部完成 `{total, success, skipped, errors, outputDir, totalElapsed}` |
| `vadCut.on('init:folder', cb)` | M→R | 命令行参数传入的文件夹路径 |

---

## 常见问题

**Q: GPU 未被使用（日志显示 CPU libx264）？**
A: 查看日志中的"编码器"行，会显示每个 GPU 的失败原因。常见原因：
- NVIDIA：未安装 CUDA Runtime（去 NVIDIA 官网下载 CUDA Toolkit 12.x）
- NVIDIA RTX 5060 Ti（Blackwell）：需要驱动 ≥ 566.x
- AMD：需要 AMD Software: Adrenalin 22.x+
- Intel：需要 Intel Graphics Driver 支持 QSV

**Q: 剪辑位置不准确？**
A: 修改 `src/vad.js` 中的 VAD 参数：
- 调低 `threshold`（如 0.3）使检测更灵敏
- 调低 `minSpeechDuration`（如 0.1）减少漏检短语音

**Q: 模型下载失败？**
A: 手动下载 `silero_vad.onnx` 放入 `models/` 目录：
`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`

**Q: 处理后视频文件很大？**
A: 统一输出为 CBR 2500kbps，对于本身码率较低的视频会放大体积。如需调整，修改 `src/ffmpegUtils.js` 中的 `-b:v 2500k` 参数。

**Q: 处理速度慢？**
A: CPU 模式下每路编码已开启多线程（libx264 默认），建议使用 GPU 加速。GPU 模式下 3 路并发，最大化利用显卡。

**Q: 输出文件已存在时如何重新处理？**
A: 删除 `剪辑/` 子目录中对应的 `.mp4` 文件，再次运行即可。
