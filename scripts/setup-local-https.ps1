param([switch]$CheckOnly, [switch]$InstallTrust)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$httpsDir = Join-Path $projectRoot '.runtime\https'
$openssl = Get-Command openssl.exe -ErrorAction SilentlyContinue
if ($null -eq $openssl) {
    Write-Error 'OpenSSL was not found. Install OpenSSL or mkcert, then rerun this script.'
}

New-Item -ItemType Directory -Path $httpsDir -Force | Out-Null
$rootKey = Join-Path $httpsDir 'local-root-ca-key.pem'
$rootCert = Join-Path $httpsDir 'local-root-ca.crt'
$serverKey = Join-Path $httpsDir 'server-key.pem'
$serverCsr = Join-Path $httpsDir 'server.csr'
$serverCert = Join-Path $httpsDir 'server-cert.pem'
$configPath = Join-Path $httpsDir 'openssl-san.cnf'

$addresses = @(
    [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        ForEach-Object { $_.Address } |
        Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not [System.Net.IPAddress]::IsLoopback($_)
        } |
        ForEach-Object { $_.IPAddressToString } |
        Sort-Object -Unique
)

$certificateValid = Test-Path -LiteralPath $serverCert -PathType Leaf
if ($certificateValid) {
    & $openssl.Source x509 -in $serverCert -noout -checkend 2592000 | Out-Null
    $certificateValid = $LASTEXITCODE -eq 0
    foreach ($address in @('127.0.0.1') + $addresses) {
        $matchResult = & $openssl.Source x509 -in $serverCert -noout -checkip $address
        if ($LASTEXITCODE -ne 0 -or $matchResult -notmatch 'does match certificate') { $certificateValid = $false }
    }
    $hostMatch = & $openssl.Source x509 -in $serverCert -noout -checkhost localhost
    if ($LASTEXITCODE -ne 0 -or $hostMatch -notmatch 'does match certificate') { $certificateValid = $false }
}
if ($CheckOnly) {
    if ($certificateValid) { Write-Host 'HTTPS certificate covers current addresses and is not near expiry.'; exit 0 }
    Write-Warning 'HTTPS certificate is missing, near expiry, or does not cover the current IP address.'
    exit 2
}
if ($InstallTrust) {
    if (-not $certificateValid) { throw 'Run https:setup first to renew the certificate before trusting it.' }
    Import-Certificate -FilePath $rootCert -CertStoreLocation 'Cert:\CurrentUser\Root' | Select-Object Subject, Thumbprint
    Write-Host 'Trusted AIEnglish local CA for the current Windows user only. Other devices require separate trust.'
    exit 0
}
if ($certificateValid) { Write-Host 'Existing certificate is valid; no replacement required.'; exit 0 }
foreach ($existing in @($serverKey, $serverCert)) {
    if (Test-Path -LiteralPath $existing -PathType Leaf) { Copy-Item -LiteralPath $existing -Destination ($existing + '.previous-' + (Get-Date -Format 'yyyyMMddHHmmss')) }
}

$altNames = @('DNS.1 = localhost', 'IP.1 = 127.0.0.1')
for ($index = 0; $index -lt $addresses.Count; $index++) {
    $altNames += "IP.$($index + 2) = $($addresses[$index])"
}

$config = @"
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[ dn ]
CN = AIEnglish Local
O = AIEnglish Personal Archive

[ req_ext ]
subjectAltName = @alt_names

[ alt_names ]
$($altNames -join [Environment]::NewLine)

[ root_ext ]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer

[ server_ext ]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
"@
Set-Content -LiteralPath $configPath -Value $config -Encoding ascii

if (-not (Test-Path -LiteralPath $rootKey -PathType Leaf) -or -not (Test-Path -LiteralPath $rootCert -PathType Leaf)) {
    & $openssl.Source req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout $rootKey -out $rootCert -subj '/CN=AIEnglish Local Root CA/O=AIEnglish Personal Archive' -config $configPath -extensions root_ext
    if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to create the local root certificate.' }
}

& $openssl.Source req -new -newkey rsa:2048 -nodes -keyout $serverKey -out $serverCsr -config $configPath
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to create the server certificate request.' }
& $openssl.Source x509 -req -in $serverCsr -CA $rootCert -CAkey $rootKey -CAcreateserial -out $serverCert -days 825 -sha256 -extfile $configPath -extensions server_ext
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to sign the server certificate.' }

Write-Host 'Local HTTPS certificate created.' -ForegroundColor Green
Write-Host "Root certificate to install on trusted devices: $rootCert" -ForegroundColor Cyan
Write-Host 'Restart AIEnglish. Secure access will use port 4174.' -ForegroundColor Cyan
