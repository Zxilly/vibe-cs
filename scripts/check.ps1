[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot

Push-Location $workspaceRoot
try {
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-rust-format.ps1
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    corepack pnpm install --frozen-lockfile
    corepack pnpm typecheck
    corepack pnpm test
    corepack pnpm build
}
finally {
    Pop-Location
}

