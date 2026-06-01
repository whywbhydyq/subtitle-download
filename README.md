# subtitle-download

纯前端链接媒体诊断、音频捕获、本地转文字和 SRT 导出工具。

## 功能

- 输入 YouTube 链接后检测：连接、可操作、可播放。
- 输入 MP4 / WebM / MP3 / WAV / HLS 等媒体直链后检测：连接、可操作、可播放、可捕获音频。
- 使用 `HTMLMediaElement.captureStream()` 和 `MediaRecorder` 捕获音频。
- 使用 Transformers.js / Whisper 在浏览器本地转文字。
- 导出音频、TXT、SRT。

## 注意

YouTube iframe 音频不能被纯前端页面直接捕获给 ASR。YouTube 链接只做播放诊断；要转文字，需要媒体直链、本地文件上传或合法服务端音频提取管线。
