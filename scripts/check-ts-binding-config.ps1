[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot

Push-Location $workspaceRoot
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $featureTree = cargo tree -e features -i ts-rs 2>&1 | Out-String
    $cargoExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($cargoExitCode -ne 0) {
        throw "cargo tree could not resolve the ts-rs feature graph.`n$featureTree"
    }

    $missingFeatures = @(
        'serde-compat',
        'no-serde-warnings'
    ) | Where-Object { $featureTree -notmatch "ts-rs feature `"$([regex]::Escape($_))`"" }

    if ($missingFeatures.Count -ne 0) {
        $missing = $missingFeatures -join ', '
        throw @"
The TypeScript binding toolchain is missing required ts-rs features: $missing.

ts-rs intentionally prints compiler-like diagnostics for unsupported Serde
attributes even when those attributes do not affect the generated TypeScript
shape. Keep serde-compat enabled for supported shape attributes, and enable
no-serde-warnings on the workspace dependency so every binding-producing crate
uses the same accurate, quiet configuration.
"@
    }

    Write-Host 'ts-rs binding feature configuration passed'
}
finally {
    Pop-Location
}
