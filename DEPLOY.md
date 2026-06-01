# subtitle-download 部署说明

这是纯静态网站，不需要 npm install，不需要 npm run build。

本地预览：

```powershell
cd "D:\桌面\统一管理\gitlcp\subtitle-download"
py -m http.server 8080
```

然后访问：

```text
http://localhost:8080/
```

旧版 M3U8 播放器/转换器文件已经从这个压缩包移除。如果你是在旧目录上覆盖，请先删除旧目录中的 `m3u8_to_mp4/`、`post/`、`assets/m3u8-mp4-converter.js` 等旧文件，或直接解压到一个空目录。
