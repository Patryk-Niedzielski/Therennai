# Installs the local model engine and creates the Therennai 1.0 model.
# Needs about 8 GB of free disk space (engine plus the 3.3 GB base model, with room to spare).

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$requiredGB = 8
$engine = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"

$freeGB = [math]::Round((Get-PSDrive ($env:LOCALAPPDATA.Substring(0, 1))).Free / 1GB, 1)
if ($freeGB -lt $requiredGB) {
    throw "Therennai's brain needs about $requiredGB GB free, but only $freeGB GB is free. Free up some space and run this again."
}

if (-not (Test-Path $engine)) {
    Write-Host "Installing Therennai's model engine..."
    winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
    if (-not (Test-Path $engine)) { throw "The model engine didn't install." }
}

# Therennai starts the engine itself when needed, so don't run its tray app at sign-in.
Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) "Ollama.lnk") -ErrorAction SilentlyContinue
Get-Process "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force

$server = $null
try { Invoke-RestMethod "http://127.0.0.1:11434/api/version" | Out-Null }
catch {
    $server = Start-Process $engine -ArgumentList "serve" -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 3
}

try {
    Write-Host "Downloading the base model (about 3.3 GB)..."
    & $engine pull gemma3:4b
    if ($LASTEXITCODE -ne 0) { throw "Downloading the base model failed." }

    Write-Host "Creating Therennai 1.0..."
    & $engine create therennai:1.0 -f (Join-Path $root "models\therennai-1.0\Modelfile")
    if ($LASTEXITCODE -ne 0) { throw "Creating Therennai 1.0 failed." }
}
finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "Therennai 1.0 is ready. Open Therennai from the desktop."
