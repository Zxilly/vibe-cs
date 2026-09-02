[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dependencyRoot = Join-Path $repositoryRoot '.deps'
$destination = Join-Path $dependencyRoot 'ffmpeg'
$sdkVersion = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1'
$archive = Join-Path $dependencyRoot "$sdkVersion.zip"
$releaseBaseUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
$downloadUrl = "$releaseBaseUrl/$sdkVersion.zip"
$checksumUrl = "$releaseBaseUrl/checksums.sha256"
$checksumFile = Join-Path $dependencyRoot 'ffmpeg-checksums.sha256'
$markerName = '.vibe-cs-sdk-version'
$cliExecutables = @('ffmpeg.exe', 'ffplay.exe', 'ffprobe.exe')

function Remove-FfmpegCliExecutables {
    param([Parameter(Mandatory = $true)][string]$SdkRoot)

    foreach ($name in $cliExecutables) {
        $path = Join-Path $SdkRoot "bin\$name"
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Invoke-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    & curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 20 --output $OutputPath $Uri
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to download $Uri"
    }
}

if ((Test-Path -LiteralPath (Join-Path $destination 'lib\avcodec.lib')) -and
    (Test-Path -LiteralPath (Join-Path $destination $markerName)) -and
    ((Get-Content -Raw -LiteralPath (Join-Path $destination $markerName)).Trim() -eq $sdkVersion)) {
    Remove-FfmpegCliExecutables -SdkRoot $destination
    exit 0
}

New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null
$checksumPartial = "$checksumFile.partial"
Remove-Item -LiteralPath $checksumPartial -Force -ErrorAction SilentlyContinue
Invoke-VerifiedDownload -Uri $checksumUrl -OutputPath $checksumPartial
Move-Item -LiteralPath $checksumPartial -Destination $checksumFile -Force
$archiveName = Split-Path -Leaf $archive
$checksumPattern = '^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($archiveName) + '$'
$checksumLine = Get-Content -LiteralPath $checksumFile |
    Where-Object { $_ -match $checksumPattern } |
    Select-Object -First 1
if ($null -eq $checksumLine) {
    throw "The FFmpeg release checksum manifest does not contain $archiveName"
}
$expectedSha256 = [regex]::Match($checksumLine, $checksumPattern).Groups[1].Value.ToLowerInvariant()

if (Test-Path -LiteralPath $archive) {
    $cachedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($cachedSha256 -ne $expectedSha256) {
        Remove-Item -LiteralPath $archive -Force
    }
}
if (-not (Test-Path -LiteralPath $archive)) {
    $partial = "$archive.partial"
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    Invoke-VerifiedDownload -Uri $downloadUrl -OutputPath $partial
    Move-Item -LiteralPath $partial -Destination $archive
}

$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw "FFmpeg SDK checksum mismatch: expected $expectedSha256, received $actualSha256"
}

$staging = Join-Path $dependencyRoot ('.ffmpeg-staging-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $archive -DestinationPath $staging
$source = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
if ($null -eq $source -or -not (Test-Path -LiteralPath (Join-Path $source.FullName 'lib\avcodec.lib'))) {
    throw 'Downloaded FFmpeg SDK does not contain the expected import libraries.'
}
Remove-FfmpegCliExecutables -SdkRoot $source.FullName
Set-Content -NoNewline -LiteralPath (Join-Path $source.FullName $markerName) -Value $sdkVersion
$previous = $null
if (Test-Path -LiteralPath $destination) {
    $previous = Join-Path $dependencyRoot ('.ffmpeg-previous-' + [guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $destination -Destination $previous
}
try {
    Move-Item -LiteralPath $source.FullName -Destination $destination
} catch {
    if ($null -ne $previous -and -not (Test-Path -LiteralPath $destination)) {
        Move-Item -LiteralPath $previous -Destination $destination
    }
    throw
}
if ($null -ne $previous) {
    Remove-Item -LiteralPath $previous -Recurse -Force
}
Remove-Item -LiteralPath $staging -Recurse -Force
