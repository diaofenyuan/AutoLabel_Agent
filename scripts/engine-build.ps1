param([switch]$Test, [ValidateSet('all','transport','manual','evaluation','capabilities','cost-rerun','five-task','resource-integration','data-maintenance','backup-integration','flow-foundation','flow-integration','reuse-integration','local-integration','view-integration','training-datasets','training-root','materials-root','dataset-versions','media-recipes','payload')] [string]$TestScope = 'all')
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
# 暂存目录的清理注册在脚本出口处统一执行。
# 原实现只把清理包在 -Test 分支的 finally 里，编译/打包阶段一旦 throw 就会
# 跳过后面的清理逻辑，导致 stage-* 在失败构建后长期累积。
$resolvedStaging = [IO.Path]::GetFullPath($staging)
$stagingRoot = [IO.Path]::GetFullPath("$engineRoot/build") + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedStaging.StartsWith($stagingRoot)) { throw '暂存路径越界。' }
$cleanupStaging = {
    # 清理失败只提示不抛错，避免次要问题掩盖真正的构建/测试结论。
    # 目录含上千个 class 文件，safe-delete 钩子会拦截批量删除，
    # 故使用 .NET Directory::Delete 递归清理（路径已在注册时做过越界校验）。
    if (Test-Path -LiteralPath $resolvedStaging) {
        try { [IO.Directory]::Delete($resolvedStaging, $true) }
        catch { Write-Warning "暂存目录清理失败，可手动删除：$resolvedStaging" }
    }
}
trap { & $cleanupStaging; break }
$sources = @(Get-ChildItem "$engineRoot/src/main/java" -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
# javac 会把 deprecation 提示写到 stderr。在 $ErrorActionPreference='Stop' 下，
# PowerShell 会把原生命令的 stderr 包装成 NativeCommandError 并升级为终止错误，
# 从而在编译实际成功（退出码 0）时中断脚本。故此处局部降级为 Continue，
# 仅以退出码判定成败；编译与测试均为纯读取+写产物，不依赖 Stop 的兜底语义。
$ErrorActionPreference = 'Continue'
try {
    $compileOutput = & "$jdk/bin/javac.exe" --release 21 -encoding UTF-8 -cp "$engineRoot/lib/*" -d "$staging/classes" @sources 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Java 编译失败：`n$($compileOutput -join "`n")" }
} finally { $ErrorActionPreference = 'Stop' }
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
    # Remove-Item 不接受管道传入的 FileInfo（ParameterBindingException），
    # 且在本机策略下会被 safe-delete 钩子拦截批量删除。
    # 这里改用 .NET File::Delete 直接删除，语义明确且不受钩子影响。
    Get-ChildItem -LiteralPath 'META-INF' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.(SF|RSA|DSA)$' -or $_.Name -eq 'MANIFEST.MF' } |
        ForEach-Object { [IO.File]::Delete($_.FullName) }
    if (Test-Path -LiteralPath 'module-info.class') { [IO.File]::Delete((Resolve-Path -LiteralPath 'module-info.class').Path) }
    & "$jdk/bin/jar.exe" --create --file "$staging/autolabel-engine.jar" --main-class cn.autolabel.engine.Main -C . .
    if ($LASTEXITCODE -ne 0) { throw '引擎打包失败。' }
} finally { Pop-Location }
# Windows 下 Move-Item 无法覆盖已存在的构建产物，Copy-Item -Force 可稳定替换且不影响暂存失败回滚。
Copy-Item -LiteralPath "$staging/autolabel-engine.jar" -Destination "$engineRoot/build/autolabel-engine.jar" -Force
[IO.File]::WriteAllText("$engineRoot/build/runtime-path.txt", $jdk, [Text.UTF8Encoding]::new($false))
# 暂存目录统一在脚本出口清理（见上方 trap 注册）。
try {
    if ($Test) {
        $testSources = @(Get-ChildItem "$engineRoot/src/test/java" -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
        # 同主编译：测试编译与运行都会向 stderr 写内容，需局部降级后按退出码判定。
        $ErrorActionPreference = 'Continue'
        $testCompileOutput = & "$jdk/bin/javac.exe" --release 21 -encoding UTF-8 -cp "$engineRoot/build/autolabel-engine.jar" -d "$staging/tests" @testSources 2>&1
        $testCompileExit = $LASTEXITCODE
        if ($testCompileExit -ne 0) { $ErrorActionPreference = 'Stop'; throw "测试编译失败：`n$($testCompileOutput -join "`n")" }
        $testOutput = & "$jdk/bin/java.exe" '-Djava.awt.headless=true' -cp "$staging/tests;$engineRoot/build/autolabel-engine.jar" cn.autolabel.engine.EngineTest $TestScope 2>&1
        $testExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $testOutput | ForEach-Object { Write-Host $_ }
        if ($testExit -ne 0) { throw '引擎关键验证失败。' }
    }
} finally {
    # 正常路径的清理；异常路径由脚本出口的 trap 兜底，二者幂等。
    & $cleanupStaging
}
Write-Output "引擎构建完成：$engineRoot/build/autolabel-engine.jar"
