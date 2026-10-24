# Regenerates assets/icon.ico (the exe, shortcut and title bar icon) from ui/icon.svg,
# so the app icon always matches the one in the interface. Renders with Microsoft Edge in headless mode.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$svgPath = Join-Path $root "ui\icon.svg"
$iconPath = Join-Path $root "assets\icon.ico"

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge is needed to render the icon." }

$work = Join-Path ([IO.Path]::GetTempPath()) ("therennai-icon-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
$svg = [IO.File]::ReadAllText($svgPath)

function New-IconPng([int]$size) {
    $html = Join-Path $work "icon-$size.html"
    $png = Join-Path $work "icon-$size.png"
    [IO.File]::WriteAllText($html,
        "<!doctype html><html><body style='margin:0;background:transparent'>" +
        "<div style='width:${size}px;height:${size}px'>$svg</div></body></html>")
    # Run as a separate process: Edge reports "bytes written" on stderr, which PowerShell would treat as an error.
    Start-Process -FilePath $edge -Wait -WindowStyle Hidden -ArgumentList @(
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
        "--user-data-dir=`"$work\profile`"", "--window-size=$size,$size", "--screenshot=`"$png`"",
        ([Uri]$html).AbsoluteUri)
    for ($i = 0; $i -lt 50 -and -not (Test-Path $png); $i++) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $png)) { throw "Rendering the $size px icon failed." }
    return , [IO.File]::ReadAllBytes($png)
}

try {
    $sizes = 16, 24, 32, 48, 64, 128, 256
    $images = foreach ($size in $sizes) { , (New-IconPng $size) }

    # ICO container with PNG-compressed entries
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $out
    $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
        $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([UInt16]1); $w.Write([UInt16]32)
        $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($img in $images) { $w.Write($img) }
    $w.Flush()
    [IO.File]::WriteAllBytes($iconPath, $out.ToArray())
}
finally {
    Start-Sleep -Milliseconds 500
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Wrote $iconPath"
