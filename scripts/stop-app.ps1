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
        Write-Error 'AIEnglish is running without a managed PID file. No process was stopped.'
    }
    Write-Host 'AIEnglish is not running.' -ForegroundColor Yellow
    exit 0
}

$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$processId = 0
if (-not [int]::TryParse($pidText, [ref]$processId)) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Error 'The invalid PID file was removed.'
}

$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'AIEnglish was already stopped; stale state was removed.' -ForegroundColor Yellow
    exit 0
}

if ($process.ProcessName -ne 'node') {
    Write-Error "PID $processId is not a Node.js process. No process was stopped."
}

$managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
$expectedEntry = Join-Path $projectRoot 'server\app.mjs'
if ($null -eq $managedProcess -or -not $managedProcess.CommandLine.Contains($expectedEntry)) {
    throw 'The PID does not belong to this AIEnglish workspace. No process was stopped.'
}

Stop-Process -Id $processId
Wait-Process -Id $processId -Timeout 8 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

if (Test-AIEnglishHealth) {
    Write-Error 'The process was stopped, but the port still responds. Try again shortly.'
}

Write-Host 'AIEnglish stopped.' -ForegroundColor Green
exit 0
