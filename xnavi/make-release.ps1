# make-release.ps1 - package a self-contained nav release (nav + progress data only)
# Usage: powershell -File make-release.ps1 [-Version TOTKNavi-v2.1.1]
# Output: release\<Version>\ with data\<required progress/sky files> + TOTKnavi.exe + xnavi.exe
# The map web app (app/) is NOT bundled: PC uses the online map (totk.yalin.site);
# phone mirror (/botw/) only activates when an app/ dir is present next to the exe
# (development machine), and its absence does not affect navigation/progress.
param(
  [string]$Version = "TOTKNavi-v2.1.1"
)
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$rel    = Join-Path $root "release\$Version"
$appSrc = Join-Path $root "app"
$dataSrc = Join-Path $appSrc "data"
$dataDst = Join-Path $rel "data"

# data files required by xnavi core (progress + sky layer):
#   totk_save_hashes.js / explore_save_map.js -> progress counts
#   area_sky.js / markers.js                  -> sky layer detection
$required = @('totk_save_hashes.js','explore_save_map.js','area_sky.js','markers.js')

New-Item -ItemType Directory -Force $rel | Out-Null

# 1) data: real copy of required files only
New-Item -ItemType Directory -Force $dataDst | Out-Null
foreach ($f in $required) {
  $src = Join-Path $dataSrc $f
  if (-not (Test-Path $src)) { throw "required data missing: $src" }
  Copy-Item $src $dataDst -Force
}

# 2) remove stale app junction/dir from previous packages (nav release does not ship app)
$appDst = Join-Path $rel "app"
if (Test-Path $appDst) { Remove-Item $appDst -Force -Recurse }

# 3) exes
Copy-Item (Join-Path $root "xnavi\xnavi.exe")                  $rel -Force
Copy-Item (Join-Path $root "xnavi-gui\build\bin\TOTKnavi.exe") $rel -Force

# 4) certs (V2.1.1 phone anti-sleep Https): ship rootCA.pem + gen-cert.ps1 + README.md
#    NO private keys in the public package (server.pem/key are machine-specific,
#    each machine runs certs/gen-cert.ps1 to mint its own).
#    rootCA.pem = phone install once (10y). Missing certs/ -> Https option unavailable.
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

# 5) verify
$sz = (Get-ChildItem $rel -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "done. package=$([Math]::Round($sz/1MB,1)) MB"
Get-ChildItem $dataDst | ForEach-Object { Write-Host "  data/$($_.Name) $($_.Length)" }
Write-Host "release: $rel"
