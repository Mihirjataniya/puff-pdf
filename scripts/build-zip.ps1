# Rebuilds docs/puff-pdf.zip (the extension bundle the landing page serves).
# Run from anywhere:  powershell -File scripts\build-zip.ps1
# Produces a spec-compliant zip (forward-slash entries) with manifest.json at root,
# so "Load unpacked" points straight at the unzipped folder on any OS.

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root  = Split-Path -Parent $PSScriptRoot          # repo root (scripts/..)
$stage = Join-Path $env:TEMP "puffpdf_stage_build"
$zip   = Join-Path $root "docs\puff-pdf.zip"

# Extension files only — no docs/, .git/, node_modules/, or local helpers.
$items = @(
  "manifest.json","background.js","popup.html","popup.js",
  "viewer.html","viewer.css","split.html","split.css",
  "README.md","PRIVACY.md","src","lib","icons"
)

if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($it in $items) { Copy-Item -LiteralPath (Join-Path $root $it) -Destination $stage -Recurse -Force }

if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
$fs   = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$arch = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$prefix = $stage.TrimEnd('\') + '\'
Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($prefix.Length).Replace('\','/')
  $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
  $es = $entry.Open()
  $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
  $es.Write($bytes, 0, $bytes.Length)
  $es.Close()
}
$arch.Dispose(); $fs.Close()
Remove-Item -LiteralPath $stage -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length/1MB, 2)
Write-Output "Built docs\puff-pdf.zip ($size MB)"
