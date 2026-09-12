param([switch]$HomePath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$candidates = @($env:AUTOLABEL_JAVA_HOME, "$root/.tools/java", "$root/engine/runtime")
$candidates += @(Get-ChildItem 'C:/Program Files/Eclipse Adoptium','C:/Program Files/Java',"$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $java = Join-Path $candidate 'bin/java.exe'
    if (-not (Test-Path -LiteralPath $java)) { continue }
    $release = Join-Path $candidate 'release'
    if ((Test-Path -LiteralPath $release) -and (Select-String -LiteralPath $release -Pattern '^JAVA_VERSION="21\.' -Quiet)) {
        if ($HomePath) { [IO.Path]::GetFullPath($candidate) } else { [IO.Path]::GetFullPath($java) }
        exit 0
    }
}
throw '未找到 Java 21。请设置 AUTOLABEL_JAVA_HOME，或将运行时放入 .tools/java。'
