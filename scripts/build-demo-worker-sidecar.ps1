$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$targetTriple = (& rustc --print host-tuple).Trim()
if (-not $targetTriple) {
    throw 'Unable to resolve the Rust host tuple for the demo worker sidecar.'
}
$binaryName = "vibe-cs-demo-worker-$targetTriple.exe"
$binaryDirectory = Join-Path $workspaceRoot 'apps\desktop\src-tauri\binaries'
$builtBinary = Join-Path $workspaceRoot 'target\release\vibe-cs-demo-worker.exe'
$publishedBinary = Join-Path $binaryDirectory $binaryName
$publishedHash = "$publishedBinary.sha256"
$developmentBinary = Join-Path $workspaceRoot 'target\debug\vibe-cs-demo-worker.exe'

function Copy-FileAtomically {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Source,
        [Parameter(Mandatory = $true)]
        [string] $Destination
    )

    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ".$([IO.Path]::GetFileName($Destination)).$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

cargo build --release --locked -p vibe-cs-demo-worker
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to build the demo worker sidecar.'
}

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $developmentBinary) | Out-Null
Copy-FileAtomically -Source $builtBinary -Destination $publishedBinary

$digest = Get-Sha256Hex -Path $publishedBinary
$temporaryHash = Join-Path $binaryDirectory ".$([IO.Path]::GetFileName($publishedHash)).$([Guid]::NewGuid().ToString('N')).tmp"
try {
    [IO.File]::WriteAllText($temporaryHash, "$digest`n", [Text.Encoding]::ASCII)
    Move-Item -LiteralPath $temporaryHash -Destination $publishedHash -Force
} finally {
    if (Test-Path -LiteralPath $temporaryHash) {
        Remove-Item -LiteralPath $temporaryHash -Force
    }
}
Copy-FileAtomically -Source $publishedBinary -Destination $developmentBinary

Write-Host "Published $publishedBinary"
