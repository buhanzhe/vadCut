# VAD-Cut

![VAD-Cut 截图](build/app.png)

`VAD-Cut` 是一个面向 Windows 的课程录屏批处理工具，基于 `Silero VAD` 自动定位有效语音边界，用来批量掐头去尾；同时提供独立的字幕提取模式，支持多种 `sherpa-onnx-node` 字幕方案按需下载。

## 当前能力

| 能力 | 说明 |
|------|------|
| 剪辑模式 | 自动定位第一句话和最后一句话，裁掉头尾静默或杂音片段 |
| 字幕模式 | 不改视频本体，直接在原目录批量生成 `.srt` |
| 多字幕方案 | 支持 Paraformer、Zipformer、SenseVoice、Offline Paraformer、Whisper Turbo |
| 下载管理 | 字幕模型按需下载，可取消，当前方案会持久化保存 |
| GPU 编码 | 自动探测 NVIDIA NVENC / AMD AMF / Intel QSV，失败时回退 `libx264` |
| ASR Provider 回退 | `Offline Paraformer` 支持 `DirectML -> CPU` 回退 |
| 批量处理 | 剪辑模式最多 4 路并发；字幕模式使用独立子进程，最多 2 路并发 |
| 容错与跳过 | 已存在输出文件会自动跳过；任务支持取消 |

## 处理策略

- 视频剪辑输出统一为 `MP4`
- 视频画面统一处理为 `1280x720 / 24fps`
- 视频滤镜包含缩放、补边、降噪、轻度色彩修正与锐化控制
- 音频链包含高通、降噪、低通与 AAC `128k`
- VAD 首尾边界带有短噪声聚类过滤，避免把孤立杂音误判为正文
- 字幕分句使用独立 VAD 策略，过长结果会自动细分，流式方案带句首/句尾补救重识别

## 支持格式

**输入：** `.mp4` `.mkv` `.avi` `.mov` `.mts` `.m2ts` `.ts` `.flv` `.wmv` `.webm` `.mpg` `.mpeg` `.m4v`

**输出：**

- 剪辑模式：`剪辑/*.mp4`
- 字幕模式：原目录同名 `.srt`

## 运行环境

- Windows 10/11 x64
- Node.js `>= 18`

说明：

- 仓库内置 `vendor/sherpa-onnx-win-x64`，`npm install` 后会自动执行 `postinstall`，让 `sherpa-onnx-node` 固定走这套 vendored runtime
- 不需要额外安装系统级 `ffmpeg`

## 快速开始

```bash
npm install
npm run setup
npm start
```

其中：

- `npm run setup` 会下载 `models/silero_vad.onnx`
- 首次使用某个字幕方案时，会在应用内提示下载对应模型

## 使用方式

### 1. 剪辑模式

1. 打开左侧 `剪辑` 标签
2. 选择包含视频的文件夹
3. 点击 `开始剪辑`
4. 结果输出到原目录下的 `剪辑/` 子目录

示例：

```text
课程录屏/
├── 01.mts
├── 02.mts
└── 剪辑/
    ├── 01.mp4
    └── 02.mp4
```

### 2. 提取字幕模式

1. 打开左侧 `提取字幕` 标签
2. 选择包含视频的文件夹
3. 选择字幕方案
4. 如模型未就绪，先下载模型
5. 点击 `开始提取字幕`

示例：

```text
课程录屏/
├── 01.mts
├── 01.srt
├── 02.mts
└── 02.srt
```

## 字幕方案

| 方案 | 类型 | 说明 |
|------|------|------|
| `paraformer-bilingual` | 在线 | 默认方案，下载体积更小，适合常规中英字幕提取 |
| `zipformer-bilingual` | 在线 | 流式 transducer 方案，适合双语内容补充 |
| `sense-voice` | 离线 | 多语种方案，适合中文、英文、粤语等混合内容 |
| `offline-paraformer-zh` | 离线 | 中文方案，支持 `DirectML / CPU`，适合本地批处理 |

字幕模型默认下载到：

```text
%USERPROFILE%\.vadCut\model\
```

## DirectML 说明

如果你想优先让 `Offline Paraformer（中文）` 走 DirectML，可以在启动前设置：

```cmd
set VADCUT_ASR_PROVIDER=directml
npm start
```

说明：

- 当前只会在支持的离线 Paraformer 方案中尝试 `directml`
- 初始化失败时会自动回退到 `cpu`
- 可用下面的诊断脚本排查设备兼容性

## 开发与诊断

```bash
# 打包 Windows 安装包
npm run build

# 运行 VAD 边界过滤测试
node --test tests/vad-edge-filter.test.js

# 对指定视频直接做字幕测试
node scripts/test-asr.js "C:\\path\\to\\video.mp4" paraformer-bilingual

# 探测 DirectML 设备（默认检测 0-3）
node scripts/diag-directml-devices.js 3
```

仓库里还保留了一批辅助脚本，主要用于：

- 字幕方案测速
- sherpa runtime / DirectML 诊断
- ModelScope 模型下载
- Electron 打包裁剪

## 打包输出

```bash
npm run build
```

输出目录：

```text
dist/
```

产物为 Windows NSIS 安装包。

## 项目结构

```text
electron/
  main.js                 Electron 主进程
  preload.js              预加载脚本
  subtitle-worker.js      字幕提取子进程入口
renderer/
  index.html              前端页面
  app.js                  前端交互逻辑
  style.css               样式
src/
  processor.js            剪辑主流程
  batchRunner.js          并发批处理调度
  ffmpegUtils.js          编码器探测与剪辑
  ffmpegRunner.js         ffmpeg 执行封装
  vad.js                  Silero VAD 与边界过滤
  subtitleVad.js          字幕分句 VAD
  asr.js                  字幕识别与 SRT 输出
  asrEngine.js            字幕方案定义与下载管理
  asrProviderConfig.js    ASR provider 配置
  audioUtils.js           音频提取与 WAV 读写
  runtimePaths.js         运行时路径解析
  taskCancellation.js     取消信号工具
scripts/
  download-model.js               下载 VAD 模型
  patch-sherpa-runtime.js         固定 vendored native runtime
  test-asr.js                     字幕测试脚本
  diag-directml-devices.js        DirectML 设备探测
  benchmark-subtitle-methods.js   字幕方案基准测试
tests/
  vad-edge-filter.test.js         VAD 首尾过滤测试
vendor/
  sherpa-onnx-win-x64/            Windows x64 Native ONNX runtime
models/
  silero_vad.onnx                 Silero VAD 模型
```

## 技术栈

- [Electron](https://www.electronjs.org/)
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
- [sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx)
- vendored `sherpa-onnx-win-x64` Windows x64 Native ONNX runtime
