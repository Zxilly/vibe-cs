$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
Push-Location $workspaceRoot
try {
    $metadataJson = & cargo metadata --format-version 1 --no-deps
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read Cargo workspace metadata.'
    }

    $metadata = $metadataJson | ConvertFrom-Json
    $workspaceMembers = @{}
    foreach ($member in $metadata.workspace_members) {
        $workspaceMembers[$member] = $true
    }
    $vendorRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'vendor')) + [IO.Path]::DirectorySeparatorChar
    $packages = @(
        $metadata.packages |
            Where-Object {
                $workspaceMembers.ContainsKey($_.id) -and
                    -not [IO.Path]::GetFullPath($_.manifest_path).StartsWith(
                        $vendorRoot,
                        [StringComparison]::OrdinalIgnoreCase
                    )
            } |
            Sort-Object name
    )
    if ($packages.Count -eq 0) {
        throw 'Cargo metadata did not report any workspace packages.'
    }

    $cargoArguments = @('fmt')
    foreach ($package in $packages) {
        $cargoArguments += @('--package', $package.name)
    }
    $cargoArguments += '--check'

    & cargo @cargoArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Rust format verification failed.'
    }
} finally {
    Pop-Location
}
