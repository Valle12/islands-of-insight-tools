#!/usr/bin/env pwsh
# Build script for compiling A* solver to WebAssembly using Emscripten
# Usage: .\build-wasm.ps1
# Requires: emsdk environment activated (run emsdk_env.ps1 first)

$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$AStarDir = Join-Path $ProjectRoot "src\pages\rolling-blocks-solver\a-star"
$OutDir = Join-Path $ProjectRoot "src\pages\rolling-blocks-solver\wasm"
$BoostInclude = "E:\packages\vcpkg\installed\x64-windows\include"

# Create output directory
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$Sources = @(
    "$AStarDir\wasm_bindings.cpp",
    "$AStarDir\AStar.cpp",
    "$AStarDir\Block.cpp"
)

$OutputJs = Join-Path $OutDir "astar.mjs"

Write-Host "Building A* WASM module..."
Write-Host "Sources: $($Sources -join ', ')"
Write-Host "Output: $OutputJs"

$EmccArgs = @(
    $Sources
    "-o", $OutputJs
    "-I", $BoostInclude
    "-std=c++23"
    "-O3"
    "-s", "WASM=1"
    "-s", "MODULARIZE=1"
    "-s", "EXPORT_NAME=createAStarModule"
    "-s", "ENVIRONMENT=web,worker"
    "-s", "ALLOW_MEMORY_GROWTH=1"
    "-s", "INITIAL_MEMORY=16777216"
    "--bind"
    "-flto"
    "-fno-exceptions"
)

& em++ @EmccArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "Emscripten compilation failed with exit code $LASTEXITCODE"
    exit 1
}

Write-Host "Build successful!"
Write-Host "Output files:"
Write-Host "  - $OutputJs"
Write-Host "  - $(Join-Path $OutDir 'astar.wasm')"
