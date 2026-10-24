# Builds Therennai.exe into dist\ and puts a Therennai shortcut on the desktop.

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dist = Join-Path $root "dist"

# A running copy locks the files in dist\; chats are saved, so closing it is safe.
Get-Process Therennai -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null; $_.WaitForExit(5000) | Out-Null }
Get-Process Therennai -ErrorAction SilentlyContinue | Stop-Process -Force

dotnet publish (Join-Path $root "src\Therennai\Therennai.csproj") -c Release -r win-x64 --self-contained false -o $dist
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

$exe = Join-Path $dist "Therennai.exe"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Therennai.lnk"))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dist
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = "Therennai"
$shortcut.Save()

Write-Host "Built $exe and created the Therennai desktop shortcut."
