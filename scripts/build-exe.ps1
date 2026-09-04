# Builds T6-YTMicCable.exe: a standalone executable that runs without
# Node.js being installed on the target machine (ffmpeg/yt-dlp/cloudflared
# are still required separately - see README.md).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "1/4: bundling with esbuild..."
New-Item -ItemType Directory -Force -Path "$root\dist" | Out-Null
& "$root\node_modules\.bin\esbuild.cmd" server.js --bundle --platform=node --outfile=dist/bundle.js

Write-Output "2/4: generating SEA blob..."
node --experimental-sea-config sea-config.json

Write-Output "3/4: copying node.exe..."
$outExe = "$root\T6-YTMicCable.exe"
if (Test-Path $outExe) { Remove-Item $outExe -Force }
Copy-Item (Get-Command node).Source $outExe

# node.exe ships code-signed; injecting the blob invalidates that signature.
# Harmless for local/personal use, but strip it first if signtool is
# available so the exe isn't left with a broken (rather than simply absent)
# signature.
$signtool = Get-Command signtool -ErrorAction SilentlyContinue
if ($signtool) {
  & $signtool remove /s $outExe | Out-Null
}

Write-Output "4/4: injecting bundle into the exe (postject)..."
& "$root\node_modules\.bin\postject.cmd" $outExe NODE_SEA_BLOB "$root\dist\sea-prep.blob" `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
  --overwrite

Write-Output ""
Write-Output "Done: $outExe"
Write-Output "Place a .env file next to the exe before running it."
