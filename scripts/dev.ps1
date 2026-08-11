[CmdletBinding()]
param(
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot

if (-not $NoInstall) {
    corepack pnpm --dir $workspaceRoot install
}

$server = Start-Process -FilePath 'cargo' `
    -ArgumentList @('run', '-p', 'vibe-cs-server') `
    -WorkingDirectory $workspaceRoot `
    -PassThru `
    -WindowStyle Hidden

try {
    corepack pnpm --dir $workspaceRoot dev
}
finally {
    if (-not $server.HasExited) {
        Stop-Process -Id $server.Id
        $server.WaitForExit()
    }
}

