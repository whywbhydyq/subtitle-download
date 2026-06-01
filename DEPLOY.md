# M3U8播放器 - 部署指南

## 已生成的文件清单

### 必需文件（SEO/AdSense）
| 文件 | 说明 | 状态 |
|------|------|------|
| `robots.txt` | 爬虫规则 | ✅ |
| `ads.txt` | AdSense验证 | ✅ |
| `sitemap.xml` | 站点地图 | ✅ |
| `vercel.json` | 安全头配置 | ✅ |
| `404.html` | 404页面 | ✅ |

### 页面文件
| 文件 | 说明 | 状态 |
|------|------|------|
| `index.html` | 首页 | ✅ |
| `player.html` | M3U8播放器 | ✅ |
| `m3u8_to_mp4/index.html` | 转MP4工具 | ✅ |
| `about.html` | 关于页面 | ✅ |
| `privacy.html` | 隐私政策 | ✅ |
| `contact.html` | 联系页面 | ✅ |
| `post/1001.html` | 文章1: 什么是m3u8协议 | ✅ |
| `post/1002.html` | 文章2: 播放M3U8视频 | ✅ |
| `post/1003.html` | 文章3: M3U8与MP4区别 | ✅ |
| `post/1004.html` | 文章4: HLS流媒体技术 | ✅ |

**总计: 10个页面 + 4个必需文件 = 14个文件**

---

## 推送步骤

### 1. 复制文件到本地仓库

将上述所有文件复制到你的本地项目目录：`D:\桌面\m3u8player`

### 2. 执行推送命令

**方式A: 双击执行**  
双击 `执行推送.ps1` 文件

**方式B: PowerShell命令**
```powershell
cd "D:\桌面\m3u8player"
python push_all.py
```

**方式C: 手动Git命令**
```powershell
cd "D:\桌面\m3u8player"
git add -A
git commit -m "feat: 重构站点 - 完善SEO、添加必需文件、优化结构"
git push origin main
```

---

## Vercel部署步骤

### 1. 导入项目
1. 访问 https://vercel.com/dashboard
2. 点击 "Add New Project"
3. 选择 `whywbhydyq/m3u8player` 仓库
4. 点击 "Import"

### 2. 配置项目
- **Framework Preset**: 选择 `Other`
- **Root Directory**: 保持默认（`./`）
- **Build Command**: 留空（静态网站无需构建）
- **Output Directory**: 留空

### 3. 添加环境变量（可选）
如果有需要，可以添加环境变量，但本站点无需额外配置。

### 4. 部署
点击 "Deploy" 按钮，等待部署完成。

### 5. 配置自定义域名
1. 进入项目设置 → Domains
2. 添加域名：`m3u8player.gitlcp.com`
3. 按照提示在 Cloudflare 添加 CNAME 记录：
   - 类型: CNAME
   - 名称: m3u8player
   - 目标: cname.vercel-dns.com

---

## 验证检查清单

### SEO检查
- [ ] 每个页面有独特的 `<title>`
- [ ] 每个页面有 `<meta description>`（150-160字符）
- [ ] 每个页面有 `<meta robots="index, follow">`
- [ ] 每个页面有 `<h1>` 标签
- [ ] 每个页面有 `<link rel="canonical">`
- [ ] 每个页面有 `<main>` 包裹主内容
- [ ] 每个页面有 JSON-LD 结构化数据
- [ ] 每个页面有 Open Graph 标签
- [ ] 每个页面有 Twitter Card 标签

### 必需文件检查
- [ ] `robots.txt` 可访问
- [ ] `ads.txt` 可访问（包含 `google.com, pub-1653188471819736, DIRECT`）
- [ ] `sitemap.xml` 可访问
- [ ] `404.html` 可访问
- [ ] `vercel.json` 已配置安全头

### 页面检查
- [ ] 首页正常显示
- [ ] 播放器页面正常
- [ ] 转MP4页面正常
- [ ] 关于页面正常
- [ ] 隐私政策页面正常
- [ ] 联系页面正常
- [ ] 4篇文章页面正常

### AdSense检查
- [ ] 隐私政策页面提到 AdSense
- [ ] 隐私政策页面提到 Cookie
- [ ] 隐私政策页面提到 Google
- [ ] 隐私政策页面有退出个性化广告链接
- [ ] 联系邮箱已填写

---

## AdSense申请建议

### 申请前准备
1. **等待收录**: 部署后等待 1-2 周让Google收录
2. **确保内容**: 确认所有页面有实质性内容，无重复
3. **检查死链**: 确保所有链接可正常访问
4. **流量积累**: 有一定自然流量后再申请（非必需但有助于通过）

### 申请地址
https://www.google.com/adsense/start

### 申请时填写
- **网站**: `https://m3u8player.gitlcp.com/`
- **内容语言**: 中文
- **网站类型**: 工具类

---

## 已完成配置

### AdSense ID
```
pub-1653188471819736
```

### 域名
```
m3u8player.gitlcp.com
```

### 联系邮箱
```
2922027393@qq.com
```

### 站点结构
```
m3u8player.gitlcp.com/
├── index.html              # 首页
├── player.html             # M3U8播放器
├── m3u8_to_mp4/            # 转MP4工具
│   └── index.html
├── about.html              # 关于
├── privacy.html            # 隐私政策
├── contact.html            # 联系我们
├── 404.html                # 404页面
├── post/                   # 文章
│   ├── 1001.html           # 什么是m3u8协议
│   ├── 1002.html           # 播放M3U8视频
│   ├── 1003.html           # M3U8与MP4区别
│   └── 1004.html           # HLS流媒体技术
├── robots.txt              # 爬虫规则
├── ads.txt                 # AdSense验证
├── sitemap.xml             # 站点地图
└── vercel.json             # 安全头配置
```

---

## 后续优化建议

1. **添加文章图片**: 目前文章使用了占位图片，建议添加相关配图
2. **多语言版本**: 如需完善英文/日文/葡萄牙语版本，需翻译所有页面
3. **统计代码**: 可添加 Google Analytics 或百度统计
4. **社交分享**: 可添加分享按钮
5. **PWA**: 可添加 Service Worker 支持离线访问

---

## 技术支持

如有问题，请联系：2922027393@qq.com