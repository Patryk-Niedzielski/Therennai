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

# Windows caches shortcut icons by file path, so give the icon a name that changes with its contents.
# Otherwise the desktop keeps showing an old icon after it's redesigned.
$iconSource = Join-Path $root "assets\icon.ico"
$hash = (Get-FileHash $iconSource -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
Get-ChildItem $dist -Filter "icon-*.ico" | Remove-Item
$icon = Join-Path $dist "icon-$hash.ico"
Copy-Item $iconSource $icon

$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Therennai.lnk"
Remove-Item $shortcutPath -ErrorAction SilentlyContinue
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dist
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = "Therennai"
$shortcut.Save()

# Ask Explorer to redraw icons.
Add-Type -Namespace Therennai -Name Shell -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);
'@
[Therennai.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Built $exe and created the Therennai desktop shortcut."
