[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dependencyRoot = Join-Path $repositoryRoot '.deps'
$destination = Join-Path $dependencyRoot 'ffmpeg'
$sdkVersion = 'ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1'
$archive = Join-Path $dependencyRoot "$sdkVersion.zip"
$downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-11-13-11/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip'
$expectedSha256 = '026f3ba22f0acf4fe58bf4da28a7eb64ffb107b270119684b91e4cace3b577aa'
$markerName = '.vibe-cs-sdk-version'

if ((Test-Path -LiteralPath (Join-Path $destination 'lib\avcodec.lib')) -and
    (Test-Path -LiteralPath (Join-Path $destination $markerName)) -and
    ((Get-Content -Raw -LiteralPath (Join-Path $destination $markerName)).Trim() -eq $sdkVersion)) {
    exit 0
}

New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    $partial = "$archive.partial"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $partial
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
