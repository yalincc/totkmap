# ============================================================
# TOTKmap V2.5 self-signed CA cert one-shot generator
#   - rootCA.pem  : root CA for phone install (10 years)
#   - server.pem  : TLS server cert for xnavi (398 days,
#                   iPhone hard limit for TLS server certs)
#   - Phone trusts rootCA.pem ONCE; re-run this script when
#     server cert expires or LAN IP changes, phone needs no reinstall.
# Usage: pwsh gen-cert.ps1
# ============================================================
$ErrorActionPreference = 'Stop'

$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
if (-not (Test-Path $openssl)) {
    throw "OpenSSL not found: $openssl (install Git for Windows)"
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# ---- 1. detect LAN IP (WLAN first, skip virtual adapters / loopback) ----
$lanIp = $null
$wlan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi|Wireless' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
if ($wlan) { $lanIp = $wlan.IPAddress }
if (-not $lanIp) {
    $any = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -eq 'Dhcp' } |
        Select-Object -First 1
    if ($any) { $lanIp = $any.IPAddress }
}
if (-not $lanIp) {
    Write-Warning 'LAN IP not detected; server cert will only cover localhost/127.0.0.1 (phone will NOT work!)'
    $lanIp = '127.0.0.1'
}
Write-Host "LAN IP: $lanIp" -ForegroundColor Cyan

# ---- 2. root CA (10 years = 3650 days) ----
if (-not (Test-Path rootCA.key)) {
    & $openssl genrsa -out rootCA.key 2048
    Write-Host 'rootCA.key generated'
} else {
    Write-Host 'rootCA.key exists, reusing (keeps already-installed phone trust valid)'
}
& $openssl req -x509 -new -key rootCA.key -sha256 -days 3650 -out rootCA.pem `
    -subj '/CN=TOTK Local CA/O=TOTKmap/OU=LAN' `
    -addext 'basicConstraints=critical,CA:TRUE' `
    -addext 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature'
Write-Host 'rootCA.pem refreshed (10y)'

# ---- 3. server private key + CSR ----
& $openssl genrsa -out server.key 2048
& $openssl req -new -key server.key -out server.csr `
    -subj "/CN=$lanIp/O=TOTKmap/OU=LAN"

# ---- 4. SAN config: localhost + 127.0.0.1 + current LAN IP ----
$san = @"
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$lanIp
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
basicConstraints=CA:FALSE
"@
Set-Content -Path san.cnf -Value $san -Encoding ascii

# ---- 5. sign server cert with CA (398 days, iPhone hard limit) ----
& $openssl x509 -req -in server.csr -CA rootCA.pem -CAkey rootCA.key `
    -CAcreateserial -days 398 -sha256 -out server.pem -extfile san.cnf

# ---- 6. cleanup temp files ----
Remove-Item -Force server.csr, san.cnf, rootCA.srl -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '========== DONE ==========' -ForegroundColor Green
Write-Host 'rootCA.pem  root CA for phone install (once, 10y)'
Write-Host "server.pem  TLS server cert for xnavi (SAN: localhost / 127.0.0.1 / $lanIp)"
Write-Host 'server.key   server private key (keep private)'
Write-Host '==========================='
