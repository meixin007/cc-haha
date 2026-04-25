# 同步上游仓库更新脚本
# 用法: .\scripts\sync-upstream.ps1 [-UpstreamUrl <原项目地址>] [-DryRun]

param(
    [string]$UpstreamUrl = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  cc-haha 上游仓库同步脚本" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $ProjectRoot

# 1. 检查 git 状态
Write-Host "[1/6] 检查 Git 状态..." -ForegroundColor Yellow
$hasChanges = git status --porcelain
if ($hasChanges) {
    Write-Host "  ⚠️ 发现未提交的修改，请先提交后再同步！" -ForegroundColor Red
    Write-Host ""
    git status --short
    exit 1
}
Write-Host "  ✅ 工作区干净" -ForegroundColor Green

# 2. 设置上游仓库（如果尚未设置）
Write-Host "[2/6] 检查上游仓库配置..." -ForegroundColor Yellow
$upstream = git remote get-url upstream 2>$null
if (-not $upstream) {
    if ($UpstreamUrl) {
        Write-Host "  添加上游仓库: $UpstreamUrl" -ForegroundColor Gray
        git remote add upstream $UpstreamUrl
    } else {
        # 尝试从 origin 推断上游地址
        $originUrl = git remote get-url origin
        Write-Host "  ⚠️ 请提供上游仓库地址：" -ForegroundColor Yellow
        Write-Host "  用法: .\scripts\sync-upstream.ps1 -UpstreamUrl '<原项目地址>'" -ForegroundColor Gray
        Write-Host ""
        $UpstreamUrl = Read-Host "请输入上游仓库 HTTPS 地址"
        if ($UpstreamUrl) {
            git remote add upstream $UpstreamUrl
        } else {
            Write-Host "  ❌ 未提供上游地址，退出。" -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "  上游仓库: $upstream" -ForegroundColor Gray
}

# 3. 拉取上游最新代码
Write-Host "[3/6] 拉取上游最新代码..." -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "  [DryRun] 跳过拉取" -ForegroundColor Gray
} else {
    git fetch upstream
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ 拉取失败，请检查网络或上游地址" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  ✅ 拉取完成" -ForegroundColor Green

# 4. 显示上游新提交
Write-Host "[4/6] 上游新提交：" -ForegroundColor Yellow
git log upstream/main --oneline -10 --not main
Write-Host ""

# 5. 合并上游更新
Write-Host "[5/6] 合并上游更新到本地分支..." -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "  [DryRun] 跳过合并" -ForegroundColor Gray
} else {
    git merge upstream/main --no-edit
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  ⚠️ 合并时发现冲突！" -ForegroundColor Red
        Write-Host ""
        Write-Host "  请手动解决以下冲突文件：" -ForegroundColor Yellow
        git diff --name-only --diff-filter=U
        Write-Host ""
        Write-Host "  解决后运行：" -ForegroundColor Gray
        Write-Host "    git add <冲突文件>" -ForegroundColor Gray
        Write-Host "    git commit -m 'merge: 同步上游更新'" -ForegroundColor Gray
        Write-Host "    git push origin main" -ForegroundColor Gray
        exit 1
    }
}
Write-Host "  ✅ 合并完成" -ForegroundColor Green

# 6. 推送到你的分叉仓库
Write-Host "[6/6] 推送到你的分叉仓库..." -ForegroundColor Yellow
if ($DryRun) {
    Write-Host "  [DryRun] 跳过推送" -ForegroundColor Gray
} else {
    git push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ 推送失败" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  ✅ 推送完成" -ForegroundColor Green

# 完成
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  ✅ 同步完成！" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  下一步：重新打包桌面端" -ForegroundColor Yellow
Write-Host "    cd desktop" -ForegroundColor Gray
Write-Host "    bun install" -ForegroundColor Gray
Write-Host "    bun run build" -ForegroundColor Gray
Write-Host ""
