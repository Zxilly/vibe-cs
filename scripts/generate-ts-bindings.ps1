[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$generatedDirectory = Join-Path $workspaceRoot 'apps\web\src\shared\desktop\generated'
$stagingDirectory = Join-Path $workspaceRoot "target\ts-rs-binding-stage-$PID"
$hadExportDirectory = Test-Path Env:TS_RS_EXPORT_DIR
$previousExportDirectory = if ($hadExportDirectory) { $env:TS_RS_EXPORT_DIR } else { $null }

Push-Location $workspaceRoot
try {
    # `.cargo/config.toml` sends ordinary test exports to the ignored root
    # target directory. Canonical generation uses an isolated staging tree so
    # Rust never truncates a checked-in .ts file currently mapped by Vite, tsc,
    # an editor, or antivirus. Only changed files are copied after every export
    # test has succeeded.
    New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null
    $env:TS_RS_EXPORT_DIR = $stagingDirectory
    cargo test --quiet --workspace export_bindings_ -- --test-threads=1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "TypeScript binding generation failed with exit code $exitCode."
    }

    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($source in Get-ChildItem -LiteralPath $stagingDirectory -File -Recurse -Filter '*.ts') {
        $relative = $source.FullName.Substring($stagingDirectory.Length).TrimStart('\', '/')
        [void]$expected.Add($relative)
        $destination = Join-Path $generatedDirectory $relative
        $destinationDirectory = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
        $changed = -not (Test-Path -LiteralPath $destination)
        if (-not $changed) {
            $sourceText = [IO.File]::ReadAllText($source.FullName)
            $destinationText = [IO.File]::ReadAllText($destination)
            $changed = $sourceText -cne $destinationText
        }
        if ($changed) {
            Copy-Item -LiteralPath $source.FullName -Destination $destination -Force
        }
    }

    foreach ($existing in Get-ChildItem -LiteralPath $generatedDirectory -File -Recurse -Filter '*.ts') {
        $relative = $existing.FullName.Substring($generatedDirectory.Length).TrimStart('\', '/')
        if (-not $expected.Contains($relative)) {
            Remove-Item -LiteralPath $existing.FullName -Force
        }
    }
}
finally {
    if ($hadExportDirectory) {
        $env:TS_RS_EXPORT_DIR = $previousExportDirectory
    }
    else {
        Remove-Item Env:TS_RS_EXPORT_DIR -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
    Pop-Location
}
