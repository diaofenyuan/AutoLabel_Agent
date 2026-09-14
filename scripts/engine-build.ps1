param([switch]$Test, [ValidateSet('all','transport','manual','evaluation','capabilities','cost-rerun','five-task','resource-integration','data-maintenance','backup-integration','flow-foundation','flow-integration','reuse-integration','local-integration','view-integration','training-datasets','materials-root')] [string]$TestScope = 'all')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$engineRoot = Join-Path $root 'engine'
$jdk = & "$PSScriptRoot/engine-java.ps1" -HomePath
$dependencies = @(
    'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar',
    'org/xerial/sqlite-jdbc/3.50.3.0/sqlite-jdbc-3.50.3.0.jar',
    'org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar',
    'org/slf4j/slf4j-nop/2.0.17/slf4j-nop-2.0.17.jar',
    'com/drewnoakes/metadata-extractor/2.19.0/metadata-extractor-2.19.0.jar',
    'com/adobe/xmp/xmpcore/6.1.11/xmpcore-6.1.11.jar'
)
New-Item -ItemType Directory -Force "$engineRoot/lib","$engineRoot/build" | Out-Null
foreach ($dependency in $dependencies) {
    $target = Join-Path "$engineRoot/lib" (Split-Path $dependency -Leaf)
    if (-not (Test-Path -LiteralPath $target)) {
        & curl.exe -fL --retry 2 --connect-timeout 15 --max-time 120 -sS "https://maven.aliyun.com/repository/central/$dependency" -o "$target.download"
        if ($LASTEXITCODE -ne 0) { throw "依赖下载失败：$dependency" }
        Move-Item -LiteralPath "$target.download" -Destination $target
    }
}
# 每次采用独立暂存目录，失败不覆盖上一次可运行产物。
$staging = Join-Path "$engineRoot/build" ('stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$staging/classes" | Out-Null
$sources = @(Get-ChildItem "$engineRoot/src/main/java" -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
& "$jdk/bin/javac.exe" --release 21 -encoding UTF-8 -cp "$engineRoot/lib/*" -d "$staging/classes" @sources
if ($LASTEXITCODE -ne 0) { throw 'Java 编译失败。' }
if (Test-Path -LiteralPath "$root/shared/assets") {
    New-Item -ItemType Directory -Force "$staging/classes/examples" | Out-Null
    Copy-Item -LiteralPath "$root/shared/assets/example-street.png","$root/shared/assets/example-street.json" -Destination "$staging/classes/examples"
}
Push-Location "$staging/classes"
try {
    foreach ($dependency in $dependencies) {
        & "$jdk/bin/jar.exe" xf (Join-Path "$engineRoot/lib" (Split-Path $dependency -Leaf))
        if ($LASTEXITCODE -ne 0) { throw '依赖展开失败。' }
    }
    Get-ChildItem -LiteralPath 'META-INF' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(SF|RSA|DSA)$' -or $_.Name -eq 'MANIFEST.MF' } | Remove-Item
    if (Test-Path -LiteralPath 'module-info.class') { Remove-Item -LiteralPath 'module-info.class' }
    & "$jdk/bin/jar.exe" --create --file "$staging/autolabel-engine.jar" --main-class cn.autolabel.engine.Main -C . .
    if ($LASTEXITCODE -ne 0) { throw '引擎打包失败。' }
} finally { Pop-Location }
# Windows 下 Move-Item 无法覆盖已存在的构建产物，Copy-Item -Force 可稳定替换且不影响暂存失败回滚。
Copy-Item -LiteralPath "$staging/autolabel-engine.jar" -Destination "$engineRoot/build/autolabel-engine.jar" -Force
[IO.File]::WriteAllText("$engineRoot/build/runtime-path.txt", $jdk, [Text.UTF8Encoding]::new($false))
if ($Test) {
    $testSources = @(Get-ChildItem "$engineRoot/src/test/java" -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
    & "$jdk/bin/javac.exe" --release 21 -encoding UTF-8 -cp "$engineRoot/build/autolabel-engine.jar" -d "$staging/tests" @testSources
    if ($LASTEXITCODE -ne 0) { throw '测试编译失败。' }
    & "$jdk/bin/java.exe" '-Djava.awt.headless=true' -cp "$staging/tests;$engineRoot/build/autolabel-engine.jar" cn.autolabel.engine.EngineTest $TestScope
    if ($LASTEXITCODE -ne 0) { throw '引擎关键验证失败。' }
}
$resolvedStaging = [IO.Path]::GetFullPath($staging)
if (-not $resolvedStaging.StartsWith([IO.Path]::GetFullPath("$engineRoot/build") + [IO.Path]::DirectorySeparatorChar)) { throw '暂存路径越界。' }
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
Write-Output "引擎构建完成：$engineRoot/build/autolabel-engine.jar"
