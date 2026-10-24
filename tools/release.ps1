# Packages Therennai for a GitHub release: release\Therennai-win-x64.zip, which the in-app updater installs.
#
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1             # build the package only
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Publish    # also create the GitHub release
#
# Raise <Version> in src/Therennai/Therennai.csproj first: installed copies update when the release tag
# (v<Version>) is newer than their own version.

param([switch]$Publish, [string]$Notes = "")

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "src\Therennai\Therennai.csproj"
$version = ([xml](Get-Content $project)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if (-not $version) { throw "No <Version> found in $project." }

$out = Join-Path $root "release"
$build = Join-Path $out "build"
$zip = Join-Path $out "Therennai-win-x64.zip"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue

dotnet publish $project -c Release -r win-x64 --self-contained false -o $build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

# Name entries with standard "/" folder separators; Windows PowerShell's zip tools write "\".
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem $build -Recurse -File) {
        $name = $file.FullName.Substring($build.Length + 1).Replace("\", "/")
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name) | Out-Null
    }
}
finally {
    $archive.Dispose()
}
Remove-Item $build -Recurse -Force
Write-Host "Packaged Therennai $version -> $zip"

if ($Publish) {
    if (-not $Notes) { $Notes = "Therennai $version" }
    gh release create "v$version" $zip --title "Therennai $version" --notes $Notes
    if ($LASTEXITCODE -ne 0) { throw "Creating the GitHub release failed." }
    Write-Host "Published release v$version."
}
