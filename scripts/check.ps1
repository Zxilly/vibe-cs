[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot

Push-Location $workspaceRoot
try {
    cargo fmt --all --check
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

