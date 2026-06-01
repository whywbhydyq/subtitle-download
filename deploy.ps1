# M3U8播放器站点 - 一键部署脚本
# 用法: .\deploy.ps1 "提交说明"

param(
    [string]$Message = "更新站点内容"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  M3U8播放器站点 - 部署工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否在正确的目录
if (-not (Test-Path ".git")) {
    Write-Host "⚠️  错误: 当前目录不是Git仓库" -ForegroundColor Red
    Write-Host "   请切换到项目根目录 (D:\桌面\m3u8player)"
    exit 1
}

Write-Host "📁 当前目录: $(Get-Location)" -ForegroundColor Gray
Write-Host ""

# 步骤1: 运行更新脚本
Write-Host "步骤 1/5: 更新现有页面..." -ForegroundColor Yellow
if (Test-Path "fix_update_pages.py") {
    python fix_update_pages.py
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️  更新脚本执行出错，继续..." -ForegroundColor Yellow
    }
} else {
    Write-Host "   跳过: fix_update_pages.py 不存在" -ForegroundColor Gray
}
Write-Host ""

# 步骤2: 检查Git状态
Write-Host "步骤 2/5: 检查Git状态..." -ForegroundColor Yellow
$status = git status --porcelain
if ([string]::IsNullOrEmpty($status)) {
    Write-Host "   没有需要提交的更改" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "   检测到更改:" -ForegroundColor Cyan
    git status -s | ForEach-Object { Write-Host "   $_" -ForegroundColor Gray }
    Write-Host ""
}

# 步骤3: 添加文件
Write-Host "步骤 3/5: 添加文件到暂存区..." -ForegroundColor Yellow
git add -A
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 添加文件失败" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ 文件已添加" -ForegroundColor Green
Write-Host ""

# 步骤4: 提交更改
Write-Host "步骤 4/5: 提交更改..." -ForegroundColor Yellow
git commit -m "$Message" --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "   没有需要提交的更改或提交失败" -ForegroundColor Yellow
} else {
    Write-Host "   ✅ 已提交: $Message" -ForegroundColor Green
}
Write-Host ""

# 步骤5: 推送到GitHub
Write-Host "步骤 5/5: 推送到GitHub..." -ForegroundColor Yellow
$branch = git branch --show-current
git push origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 推送失败" -ForegroundColor Red
    Write-Host ""
    Write-Host "可能的解决方案:" -ForegroundColor Yellow
    Write-Host "  1. 检查网络连接" -ForegroundColor Gray
    Write-Host "  2. 执行: git pull origin $branch" -ForegroundColor Gray
    Write-Host "  3. 解决冲突后重试" -ForegroundColor Gray
    exit 1
}

Write-Host "   ✅ 推送成功!" -ForegroundColor Green
Write-Host ""

# 完成
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ✅ 部署完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "📍 站点地址:" -ForegroundColor Cyan
Write-Host "   GitHub:   https://github.com/whywbhydyq/m3u8player" -ForegroundColor White
Write-Host "   线上预览: https://m3u8player.gitlcp.com/" -ForegroundColor White
Write-Host ""
Write-Host "⏰ 提示:" -ForegroundColor Cyan
Write-Host "   - Vercel 会自动部署最新代码" -ForegroundColor Gray
Write-Host "   - 更新可能有1-2分钟延迟" -ForegroundColor Gray
Write-Host "   - 可通过 Vercel Dashboard 查看部署状态" -ForegroundColor Gray
Write-Host ""

# 询问是否打开浏览器
$open = Read-Host "是否打开站点预览? (y/n)"
if ($open -eq "y" -or $open -eq "Y") {
    Start-Process "https://m3u8player.gitlcp.com/"
}
