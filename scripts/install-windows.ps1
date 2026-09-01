$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoUrl = "https://github.com/jwgmpi-wolff/wolfman.git"
$sourceDir = Join-Path $env:LOCALAPPDATA "Wolfman\source"

function Add-InstalledPaths {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Install-Package([string]$id, [string]$commandName) {
    if (Get-Command $commandName -ErrorAction SilentlyContinue) {
        return
    }

    Write-Host "Installing $commandName..."
    winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not install $commandName. Error code: $LASTEXITCODE"
    }
    Add-InstalledPaths
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Wolfman needs App Installer. Open Microsoft Store, install App Installer, then run this command again."
}

Install-Package "Git.Git" "git"
Install-Package "OpenJS.NodeJS.LTS" "node"
Install-Package "Ollama.Ollama" "ollama"

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) {
    Write-Host "Updating Node.js..."
    winget upgrade --id "OpenJS.NodeJS.LTS" --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        winget install --id "OpenJS.NodeJS.LTS" --exact --silent --accept-package-agreements --accept-source-agreements
    }
    Add-InstalledPaths
    $nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
    if ($nodeMajor -lt 22) {
        throw "Windows could not update Node.js. Remove the old Node.js, then run this command again."
    }
}

New-Item -ItemType Directory -Path (Split-Path $sourceDir) -Force | Out-Null
if (Test-Path (Join-Path $sourceDir ".git")) {
    Write-Host "Getting the newest Wolfman files..."
    git -C $sourceDir pull --ff-only
} else {
    if (Test-Path $sourceDir) {
        Remove-Item $sourceDir -Recurse -Force
    }
    Write-Host "Getting Wolfman..."
    git clone --depth 1 $repoUrl $sourceDir
}
if ($LASTEXITCODE -ne 0) {
    throw "Wolfman could not download its files."
}

$ollamaReady = $false
try {
    Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
    $ollamaReady = $true
} catch {
    Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
            $ollamaReady = $true
            break
        } catch {
        }
    }
}
if (-not $ollamaReady) {
    throw "Ollama did not start. Restart this PC, then run this command again."
}

Write-Host "Getting Wolfman's text model. This can take a while..."
ollama pull llama3.1:8b
if ($LASTEXITCODE -ne 0) { throw "The text model did not download." }

Write-Host "Getting Wolfman's picture model. This is a big download..."
ollama pull gemma4:26b
if ($LASTEXITCODE -ne 0) { throw "The picture model did not download." }

Push-Location $sourceDir
try {
    if (-not (Test-Path ".env.local")) {
        Copy-Item ".env.example" ".env.local"
    }
    Write-Host "Building Wolfman..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "Wolfman packages did not install." }
    npm run dist:windows
    if ($LASTEXITCODE -ne 0) { throw "Wolfman did not build." }

    $setup = Get-ChildItem "release\Wolfman Setup *.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $setup) { throw "The Wolfman setup file was not made." }
    Start-Process $setup.FullName -ArgumentList "/S" -Wait
} finally {
    Pop-Location
}

$app = Join-Path $env:LOCALAPPDATA "Programs\wolfman\Wolfman.exe"
if (-not (Test-Path $app)) {
    $app = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs") -Filter "Wolfman.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $app) {
    throw "Wolfman was built, but Windows could not find the app. Run the setup file in $sourceDir\release."
}

Write-Host "Wolfman is ready."
Start-Process $app