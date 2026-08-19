param(
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $projectRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'ai-english.pid'
$stdoutLog = Join-Path $runtimeDir 'server.out.log'
$stderrLog = Join-Path $runtimeDir 'server.err.log'
$serverEntry = Join-Path $projectRoot 'server\app.mjs'
$vitePackage = Join-Path $projectRoot 'node_modules\vite\package.json'
$appUrl = 'http://127.0.0.1:4173/'
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

function Open-AIEnglish {
    if (-not $NoBrowser) {
        Start-Process -FilePath $appUrl
    }
}

function Get-LanAppUrls {
    try {
        $candidates = foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) {
                continue
            }

            $properties = $networkInterface.GetIPProperties()
            $hasGateway = @($properties.GatewayAddresses | Where-Object {
                $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                $_.Address.IPAddressToString -ne '0.0.0.0'
            }).Count -gt 0
            if (-not $hasGateway) {
                continue
            }

            foreach ($unicastAddress in $properties.UnicastAddresses) {
                $address = $unicastAddress.Address
                if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
                    continue
                }

                $octets = $address.GetAddressBytes()
                $isPrivate = $octets[0] -eq 10 -or
                    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
                    ($octets[0] -eq 192 -and $octets[1] -eq 168)
                if (-not $isPrivate) {
                    continue
                }

                [pscustomobject]@{
                    Url = "http://$($address.IPAddressToString):4173/"
                    Priority = if ($networkInterface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211) { 0 } else { 1 }
                }
            }
        }

        return @($candidates | Sort-Object Priority, Url | Select-Object -ExpandProperty Url -Unique)
    }
    catch {
        return @()
    }
}

function Write-AccessUrls {
    Write-Host "电脑访问：$appUrl" -ForegroundColor Cyan
    $lanUrls = @(Get-LanAppUrls)
    if ($lanUrls.Count -eq 0) {
        Write-Host '未检测到可用的局域网地址；手机访问前请确认电脑已连接 Wi-Fi。' -ForegroundColor Yellow
        return
    }

    foreach ($lanUrl in $lanUrls) {
        Write-Host "手机访问：$lanUrl（需连接同一 Wi-Fi）" -ForegroundColor Cyan
    }
}

if (Test-AIEnglishHealth) {
    $message = if ($NoBrowser) {
        'AIEnglish 已在运行。'
    }
    else {
        'AIEnglish 已在运行，正在打开浏览器…'
    }
    Write-Host $message -ForegroundColor Green
    Write-AccessUrls
    Open-AIEnglish
    exit 0
}

if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    Write-Error "找不到服务入口：$serverEntry"
}

if (-not (Test-Path -LiteralPath $vitePackage -PathType Leaf)) {
    Write-Error '依赖尚未安装。请先在项目目录运行 npm install。'
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Write-Error '未找到 Node.js。请先安装 Node.js 20.19 或更高版本。'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    Remove-Item -LiteralPath $pidFile -Force
}

$process = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @($serverEntry, '--dev') `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) {
        break
    }
    if (Test-AIEnglishHealth) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 250
}

if (-not $ready) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $errorTail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 12) -join [Environment]::NewLine
    }
    else {
        '没有可用的错误日志。'
    }
    Write-Error "AIEnglish 启动失败。错误日志：`n$errorTail"
}

Write-Host "AIEnglish 已启动：$appUrl" -ForegroundColor Green
Write-AccessUrls
Open-AIEnglish
exit 0
