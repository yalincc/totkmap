# make-release.ps1 - package a self-contained nav release (nav + progress data only)
# Usage: powershell -File make-release.ps1 [-Version TOTKNavi-v3.0.1]
# Output: release\<Version>\ with data\<required progress/sky files> + TOTKnavi.exe + totknavi-core.exe + docs
# The map web app (app/) is NOT bundled: PC uses the online map (totk.yalin.site);
# phone mirror (/botw/) without app/ serves the embedded fallback guide page.
param(
  [string]$Version = "TOTKNavi-v3.0.1"
)
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$rel    = Join-Path $root "release\$Version"
$appSrc = Join-Path $root "app"
$dataSrc = Join-Path $appSrc "data"
$dataDst = Join-Path $rel "data"

# data files required by core (progress + sky layer + shrine entrances):
#   totk_save_hashes.js / explore_save_map.js -> progress counts
#   area_sky.js / markers.js / heightmap      -> sky/depths layer detection
$required = @('totk_save_hashes.js','explore_save_map.js','area_sky.js','markers.js','heightmap_downsampled.bin')

New-Item -ItemType Directory -Force $rel | Out-Null

# 1) data: real copy of required files only
New-Item -ItemType Directory -Force $dataDst | Out-Null
foreach ($f in $required) {
  $src = Join-Path $dataSrc $f
  if (-not (Test-Path $src)) { throw "required data missing: $src" }
  Copy-Item $src $dataDst -Force
}
# copy shrine_entrances.json from totknavi/data
$shrineJson = Join-Path $PSScriptRoot "data\shrine_entrances.json"
if (Test-Path $shrineJson) {
  Copy-Item $shrineJson $dataDst -Force
  Write-Host "  data/shrine_entrances.json"
}

# 2) remove stale app junction/dir from previous packages (nav release does not ship app)
$appDst = Join-Path $rel "app"
if (Test-Path $appDst) { Remove-Item $appDst -Force -Recurse }

# 2.5) remove runtime residue
$residue = @('status.json','xnavi-gui-config.json','known_addrs.json','known_eden_totk.json','server.pem','server.key')
foreach ($f in $residue) {
  $p = Join-Path $rel $f
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "  [clean] removed residue: $f" }
}
Get-ChildItem $rel -Filter *.log -File -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Force; Write-Host "  [clean] removed residue: $($_.Name)"
}
Get-ChildItem $rel -Filter *.bak -File -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Force; Write-Host "  [clean] removed residue: $($_.Name)"
}

# 3) exes & apk
Copy-Item (Join-Path $root "totknavi\totknavi-core.exe")                  $rel -Force
Copy-Item (Join-Path $root "totknavi-gui\build\bin\TOTKnavi.exe")        $rel -Force
$apkSrc = Join-Path $PSScriptRoot "xnavi-mirror.apk"
if (Test-Path $apkSrc) {
  Copy-Item $apkSrc $rel -Force
  Write-Host "  xnavi-mirror.apk (phone anti-sleep helper)"
}

# 4) certs (phone anti-sleep Https): ship rootCA.pem + gen-cert.ps1 + README.md
$certsSrc = Join-Path $root "certs"
$certsDst = Join-Path $rel "certs"
if (Test-Path $certsSrc) {
  New-Item -ItemType Directory -Force $certsDst | Out-Null
  Copy-Item (Join-Path $certsSrc "rootCA.pem")  (Join-Path $certsDst "rootCA.pem")  -Force
  Copy-Item (Join-Path $certsSrc "gen-cert.ps1") (Join-Path $certsDst "gen-cert.ps1") -Force
  Copy-Item (Join-Path $certsSrc "README.md")   (Join-Path $certsDst "README.md")   -Force
  Copy-Item (Join-Path $certsSrc "serve-cert.ps1") (Join-Path $certsDst "serve-cert.ps1") -Force
  Write-Host "  certs/ rootCA.pem gen-cert.ps1 serve-cert.ps1 README.md (no keys)"
} else {
  Write-Host "  [warn] certs/ not found - Https mode unavailable (run certs/gen-cert.ps1)"
}

# 4.5) Release Documents: README.txt + GUIDE.md only
#      (TROUBLESHOOTING stays online-only; both docs link to the GitHub repo)
$docDst = Join-Path $rel "TROUBLESHOOTING.md"
if (Test-Path $docDst) { Remove-Item $docDst -Force; Write-Host "  [clean] removed TROUBLESHOOTING.md (online only)" }
foreach ($doc in @('README.txt', 'GUIDE.md')) {
  $docPath = Join-Path $PSScriptRoot $doc
  if (Test-Path $docPath) {
    Copy-Item $docPath $rel -Force
    Write-Host "  $doc"
  }
}

# 5) verify & zip
$sz = (Get-ChildItem $rel -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "done. package=$([Math]::Round($sz/1MB,1)) MB"
Get-ChildItem $dataDst | ForEach-Object { Write-Host "  data/$($_.Name) $($_.Length)" }
Write-Host "release directory: $rel"

# 6) Create ZIP package
$zipPath = Join-Path $root "release\$Version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$rel\*" -DestinationPath $zipPath -Force
Write-Host "release zip created: $zipPath ($([Math]::Round((Get-Item $zipPath).Length/1MB,2)) MB)"
