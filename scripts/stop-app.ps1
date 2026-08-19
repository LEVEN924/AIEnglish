Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $projectRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'ai-english.pid'
$healthUrl = 'http://127.0.0.1:4173/api/health'

function Test-AIEnglishHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $response.ok -eq $true
    }
    catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    if (Test-AIEnglishHealth) {
        Write-Error 'AIEnglish 正在运行，但没有找到由一键脚本创建的 PID 文件。为避免误关其他 Node 进程，未执行关闭。'
    }
    Write-Host 'AIEnglish 当前未运行。' -ForegroundColor Yellow
    exit 0
}

$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$processId = 0
if (-not [int]::TryParse($pidText, [ref]$processId)) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Error 'PID 文件无效，已清理。'
}

$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'AIEnglish 已经停止，残留状态已清理。' -ForegroundColor Yellow
    exit 0
}

if ($process.ProcessName -ne 'node') {
    Write-Error "PID $processId 当前不是 Node.js 进程。为避免误关其他程序，未执行关闭。"
}

Stop-Process -Id $processId
Wait-Process -Id $processId -Timeout 8 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

if (Test-AIEnglishHealth) {
    Write-Error '进程已收到关闭命令，但端口仍在响应。请稍后再试。'
}

Write-Host 'AIEnglish 已关闭。' -ForegroundColor Green
exit 0
