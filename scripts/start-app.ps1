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
$databasePath = Join-Path $projectRoot 'data\ai-english.sqlite'
$databaseMaintenance = Join-Path $projectRoot 'scripts\database-maintenance.mjs'
$httpsCertificate = Join-Path $runtimeDir 'https\server-cert.pem'
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
    Write-Host "Desktop: $appUrl" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $httpsCertificate -PathType Leaf) {
        Write-Host 'Desktop secure: https://127.0.0.1:4174/' -ForegroundColor Cyan
    }
    $lanUrls = @(Get-LanAppUrls)
    if ($lanUrls.Count -eq 0) {
        Write-Host 'No LAN address detected. Connect the computer to Wi-Fi before mobile access.' -ForegroundColor Yellow
        return
    }

    foreach ($lanUrl in $lanUrls) {
        Write-Host "Mobile: $lanUrl (same Wi-Fi required)" -ForegroundColor Cyan
        if (Test-Path -LiteralPath $httpsCertificate -PathType Leaf) {
            $secureLanUrl = $lanUrl.Replace('http://', 'https://').Replace(':4173/', ':4174/')
            Write-Host "Mobile secure: $secureLanUrl (install the local root certificate first)" -ForegroundColor Cyan
        }
    }
}

if (Test-AIEnglishHealth) {
    $message = if ($NoBrowser) {
        'AIEnglish is already running.'
    }
    else {
        'AIEnglish is already running. Opening the browser...'
    }
    Write-Host $message -ForegroundColor Green
    Write-AccessUrls
    Open-AIEnglish
    exit 0
}

if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    Write-Error "Server entry not found: $serverEntry"
}

if (-not (Test-Path -LiteralPath $vitePackage -PathType Leaf)) {
    Write-Error 'Dependencies are missing. Run npm install in the project directory.'
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Write-Error 'Node.js was not found. Install Node.js 22.13 or newer.'
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    Write-Error 'npm was not found. Reinstall Node.js with npm enabled.'
}

if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
    Write-Host 'Creating a verified database backup...' -ForegroundColor DarkCyan
    & $nodeCommand.Source '--disable-warning=ExperimentalWarning' $databaseMaintenance backup
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Database backup failed. Startup was stopped to protect learning data.'
    }
}

Write-Host 'Building the production application...' -ForegroundColor DarkCyan
& $npmCommand.Source run build
if ($LASTEXITCODE -ne 0) {
    Write-Error 'The production build failed. The server was not started.'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    Remove-Item -LiteralPath $pidFile -Force
}

$process = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @('--disable-warning=ExperimentalWarning', $serverEntry) `
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
        'No error log is available.'
    }
    Write-Error "AIEnglish failed to start. Error log:`n$errorTail"
}

Write-Host "AIEnglish started: $appUrl" -ForegroundColor Green
Write-AccessUrls
Open-AIEnglish
exit 0
