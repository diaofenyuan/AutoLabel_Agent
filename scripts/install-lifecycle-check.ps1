$ErrorActionPreference = 'Stop'
# Install / upgrade / uninstall lifecycle acceptance against the real NSIS package.
# ASCII-only script (PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles non-ASCII literals).
# Safety: the uninstaller migrates $INSTDIR\AutoLabelData to %LOCALAPPDATA%\<product>\AutoLabelData and renames any
# existing target to a backup copy. That target may hold REAL user data, so the migration checks (and their cleanup)
# run only when the target is absent at start (profile A). With a real target present we run profile B: no seeding,
# no touching the target, migration assertions reported as skipped.
$root = 'D:\python_play_do\AutoLabel_Agent'
$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$installer = Join-Path $root ("build\release\AutoLabel-Setup-$version-x64.exe")
if (-not (Test-Path $installer)) { throw "installer missing: $installer (run npm run pack:win first)" }
$scratch = Join-Path $env:TEMP ("autolabel-lifecycle-" + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $scratch 'app'
$smokeDir = Join-Path $scratch 'smoke-user-data'
New-Item -ItemType Directory -Path $installDir, $smokeDir | Out-Null
$productData = Join-Path $env:LOCALAPPDATA 'AutoLabelData'   # placeholder replaced below by product folder name
$productRoot = Join-Path $env:LOCALAPPDATA ([char]0x81EA + [char]0x52A8 + [char]0x6807 + [char]0x6CE8 + [char]0x5C0F + [char]0x52A9 + [char]0x624B)
$migratedTarget = Join-Path $productRoot 'AutoLabelData'
$backupCopy = Join-Path $productRoot 'AutoLabelData-bench-copy'
$profile = 'A'
if (Test-Path $migratedTarget) { $profile = 'B' }
Write-Output ("profile=" + $profile + " (A: full migration checks; B: real data present, migration checks skipped)")

function Invoke-Silent([string]$file, [string[]]$extra) {
  $args = @('/S', '/NoDesktopShortcut', "/D=$installDir") + $extra
  $p = Start-Process -FilePath $file -ArgumentList $args -Wait -PassThru
  return $p.ExitCode
}
function Assert([bool]$ok, [string]$label) { if (-not $ok) { throw "LIFECYCLE FAILED: $label" }; Write-Output ("ok: " + $label) }

try {
  # ---- install ----
  $code = Invoke-Silent $installer @()
  Assert ($code -eq 0) "silent install exit 0 (got $code)"
  $exe = Get-ChildItem $installDir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  Assert ($null -ne $exe) 'installed executable exists'
  $seeded = $false
  if ($profile -eq 'A') {
    New-Item -ItemType Directory -Path $migratedTarget -Force | Out-Null
    Set-Content (Join-Path $migratedTarget 'sentinel.txt') 'pre-existing-bench-sentinel'
    $dataDir = Join-Path $installDir 'AutoLabelData'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Set-Content (Join-Path $dataDir 'marker.txt') 'bench-marker'
    $seeded = $true
  }

  # ---- installed smoke: engine communication + bundled runtime through the INSTALLED exe ----
  $smokeOut = Join-Path $scratch 'installed-smoke.json'
  $env:AUTOLABEL_TEST_USER_DATA = $smokeDir
  $env:AUTOLABEL_SMOKE_OUTPUT = $smokeOut
  $env:AUTOLABEL_EXTRA_LAUNCH_ARGS = '--no-sandbox --in-process-gpu --disable-gpu'
  $p = Start-Process -FilePath $exe.FullName -ArgumentList @('--desktop-smoke') -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "installed smoke exit 0 (got $($p.ExitCode))"
  $smoke = Get-Content $smokeOut -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert ($smoke.bridge -eq $true) 'installed app bridge works'
  Assert ($smoke.status.state -eq 'ready') 'installed app engine ready with bundled runtime'
  Assert ($smoke.diagnostics.packaged -eq $true) 'installed app reports packaged mode'
  Write-Output ("installed smoke: " + (Get-Content $smokeOut -Raw))

  # ---- upgrade in place: data must survive ----
  $code = Invoke-Silent $installer @()
  Assert ($code -eq 0) "silent upgrade exit 0 (got $code)"
  if ($seeded) { Assert ((Get-Content (Join-Path $installDir 'AutoLabelData\marker.txt') -Raw).Trim() -eq 'bench-marker') 'upgrade keeps installed-directory data' }

  # ---- negative: truncated installer must fail without damaging the existing install ----
  $truncated = Join-Path $scratch 'truncated-setup.exe'
  $bytes = [System.IO.File]::ReadAllBytes($installer)[0..4194303]
  [System.IO.File]::WriteAllBytes($truncated, $bytes)
  $p = Start-Process -FilePath $truncated -ArgumentList @('/S', '/NoDesktopShortcut', "/D=$installDir") -Wait -PassThru
  Assert ($p.ExitCode -ne 0 -or -not (Test-Path $exe.FullName)) 'truncated installer fails loudly'
  Assert (Test-Path $exe.FullName) 'existing install untouched by failed install'

  # ---- uninstall: managed data must migrate out, old copy renamed aside ----
  $uninstaller = Get-ChildItem $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
  Assert ($null -ne $uninstaller) 'uninstaller exists'
  $p = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "silent uninstall exit 0 (got $($p.ExitCode))"
  Assert (-not (Test-Path (Join-Path $installDir 'AutoLabelData'))) 'installed-directory data migrated away on uninstall'
  if ($seeded) {
    Assert ((Get-Content (Join-Path $migratedTarget 'marker.txt') -Raw).Trim() -eq 'bench-marker') 'uninstall migrates managed data to the local app data folder'
    Assert ((Get-Content (Join-Path $backupCopy 'sentinel.txt') -Raw).Trim() -eq 'pre-existing-bench-sentinel') 'pre-existing data renamed to a kept backup copy'
  } else {
    Write-Output 'skipped: migration assertions (real AutoLabelData present; refusing to touch it)'
  }
  Write-Output "LIFECYCLE PASSED (profile $profile)"
} finally {
  Remove-Item $scratch -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $installDir -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  if ($seeded) {
    Remove-Item $migratedTarget -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $backupCopy -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
}
