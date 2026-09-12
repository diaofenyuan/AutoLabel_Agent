param(
    [string]$VideoPath = '.qa/media-samples/vtest.avi',
    [string]$FfmpegPath = 'build/media-tools/ffmpeg.exe',
    [string]$FfprobePath = 'build/media-tools/ffprobe.exe',
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $video = (Resolve-Path -LiteralPath $VideoPath).Path
    $ffmpeg = (Resolve-Path -LiteralPath $FfmpegPath).Path
    $ffprobe = (Resolve-Path -LiteralPath $FfprobePath).Path
    if (-not $NoBuild) { & "$PSScriptRoot/engine-build.ps1" }
    $jdk = & "$PSScriptRoot/engine-java.ps1" -HomePath
    $classes = Join-Path $root ('engine/build/verification/media-test-classes-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $classes | Out-Null
    $jar = Join-Path $root 'engine/build/autolabel-engine.jar'
    & "$jdk/bin/javac.exe" -encoding UTF-8 -cp $jar -d $classes 'engine/src/test/java/cn/autolabel/engine/MediaJobsIntegrationTest.java'
    if ($LASTEXITCODE -ne 0) { throw '媒体集成测试编译失败。' }
    & "$jdk/bin/java.exe" '-Djava.awt.headless=true' -cp "$classes;$jar" cn.autolabel.engine.MediaJobsIntegrationTest $ffmpeg $ffprobe $video
    if ($LASTEXITCODE -ne 0) { throw '媒体关键链路验证失败。' }
} finally { Pop-Location }
