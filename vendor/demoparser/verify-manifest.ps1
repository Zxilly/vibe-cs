[CmdletBinding()]
param(
    [switch]$Update
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$vendorRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\", "/")
$manifestPath = Join-Path $vendorRoot "MANIFEST.sha256"
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Get-RelativeVendorPath {
    param([Parameter(Mandatory = $true)][string]$FullName)

    $absolutePath = [IO.Path]::GetFullPath($FullName)
    if (-not $absolutePath.StartsWith($vendorRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escaped vendored root: $absolutePath"
    }

    return $absolutePath.Substring($vendorRoot.Length + 1).Replace("\", "/")
}

function Test-IgnoredVendorPath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    if ($RelativePath -eq "MANIFEST.sha256") {
        return $true
    }

    $segments = $RelativePath.Split("/")
    if ($segments[-1] -eq "Cargo.lock") {
        return $true
    }

    return $segments -contains "target"
}

$records = New-Object 'System.Collections.Generic.List[string]'
foreach ($entry in Get-ChildItem -LiteralPath $vendorRoot -Force -Recurse) {
    $relativePath = Get-RelativeVendorPath -FullName $entry.FullName
    if (Test-IgnoredVendorPath -RelativePath $relativePath) {
        continue
    }

    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Vendored tree must not contain links or reparse points: $relativePath"
    }
    if ($entry.PSIsContainer) {
        continue
    }

    $digest = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $records.Add("$digest  $relativePath")
}

$sortedRecords = $records.ToArray()
[Array]::Sort($sortedRecords, [StringComparer]::Ordinal)
$recordBody = [string]::Join("`n", $sortedRecords) + "`n"

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $treeDigestBytes = $sha256.ComputeHash($utf8NoBom.GetBytes($recordBody))
} finally {
    $sha256.Dispose()
}
$treeDigest = ([BitConverter]::ToString($treeDigestBytes)).Replace("-", "").ToLowerInvariant()
$expectedManifest = $recordBody + "$treeDigest  TREE_SHA256`n"

if ($Update) {
    [IO.File]::WriteAllText($manifestPath, $expectedManifest, $utf8NoBom)
    Write-Output "Updated $manifestPath ($($sortedRecords.Count) files, tree $treeDigest)"
    exit 0
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing vendored manifest: $manifestPath"
}

$actualManifest = [IO.File]::ReadAllText($manifestPath).Replace("`r`n", "`n").Replace("`r", "`n")
if ($actualManifest -ne $expectedManifest) {
    throw "Vendored manifest mismatch. Run verify-manifest.ps1 -Update only after reviewing intentional source changes."
}

Write-Output "Verified $($sortedRecords.Count) files; tree SHA-256 $treeDigest"
