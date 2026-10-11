#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Installs opencode-voice-99: the plugin, a GPU-accelerated whisper.cpp, and a model.

.DESCRIPTION
  Picks a backend automatically - CUDA if an NVIDIA build is found, otherwise
  Vulkan (AMD, Intel Arc, older NVIDIA), otherwise plain CPU. Nothing here
  needs the user to know which GPU they have.

  The plugin itself is discovered from ~/.config/opencode/plugins, so this only
  downloads whisper.cpp and a model into %LOCALAPPDATA%\opencode-voice-99.

.PARAMETER Model
  Model file name to fetch. Default: ggml-large-v3-turbo-q5_0.bin

.PARAMETER Language
  Dictation language written to the config. Default: tr.
  Pass "auto" only if you mostly dictate English: auto-detection costs roughly
  twice the transcription time and mis-reads Turkish as English.

.PARAMETER Backend
  Force a backend instead of detecting one: cuda, vulkan, cpu or auto.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -Language en -Model ggml-base.en.bin

.EXAMPLE
  .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Model = "ggml-large-v3-turbo-q5_0.bin",
    [string]$Language = "tr",
    [ValidateSet("auto", "cuda", "vulkan", "cpu")]
    [string]$Backend = "auto",
    [string]$InstallDir = "",
    [string]$ConfigDir = "",
    [switch]$SkipRuntime,
    [switch]$SkipModel,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "fahrim/opencode-voice-99"
$PluginRepo = "https://github.com/$Repo.git"
$WhisperSource = "https://github.com/ggml-org/whisper.cpp"

function Say([string]$m) { Write-Host "[voice-99] $m" }
function Step([string]$m) { Write-Host ""; Write-Host "== $m" }

if (-not $InstallDir) {
    $InstallDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "opencode-voice-99" } else { Join-Path $env:USERPROFILE "opencode-voice-99" }
}
if (-not $ConfigDir) {
    $xdg = $env:XDG_CONFIG_HOME
    $ConfigDir = if ($xdg) { Join-Path $xdg "opencode" } else { Join-Path $env:USERPROFILE ".config\opencode" }
}
$runtimeDir = Join-Path $InstallDir "runtime"
$modelsDir = Join-Path $InstallDir "models"
$pluginDir = Join-Path $ConfigDir "plugins\opencode-voice-99"

# ---- decide the backend ---------------------------------------------------
# Based on what GPU is present, not on what the user intends to run.
function Detect-DesiredFlavour {
    try {
        $gpu = Get-CimInstance Win32_VideoController -ErrorAction Stop
        $names = ($gpu | ForEach-Object { $_.Name }) -join " "
        if ($names -match "NVIDIA") { return "cuda" }
        if ($names -match "AMD|Radeon|Intel.*Arc|Arc") { return "vulkan" }
    } catch {
        # fall through
    }
    return "cpu"
}

$flavour = if ($Backend -ne "auto") { $Backend } else { Detect-DesiredFlavour }
Say "install dir:  $InstallDir"
Say "plugin dir:   $pluginDir"
Say "config dir:   $ConfigDir"
Say "model:        $Model"
Say "language:     $Language"
Say "backend:      $flavour (detected)"

if ($DryRun) {
    Say "DRY RUN - nothing will be changed"
    if ($flavour -eq "vulkan") {
        Say ""
        Say "Vulkan builds are not published upstream for Windows."
        Say "Get one from: https://github.com/fahrim/whisper-vulkan-win"
        Say "then re-run this installer."
    }
    exit 0
}

# ---- prerequisites --------------------------------------------------------
Step "Checking prerequisites"
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
    Say "ffmpeg: $($ffmpeg.Source)"
} else {
    Say "ffmpeg NOT FOUND - install it: winget install Gyan.FFmpeg"
    Say "It is required for microphone capture."
}

# ---- plugin ---------------------------------------------------------------
Step "Plugin"
if (Test-Path (Join-Path $pluginDir "tui.tsx")) {
    Say "already installed at $pluginDir"
} else {
    New-Item -ItemType Directory -Force $pluginDir | Out-Null
    $tmp = Join-Path $env:TEMP "opencode-voice-99-plugin"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    & git clone --depth 1 $PluginRepo $tmp
    if ($LASTEXITCODE -ne 0) { Say "clone failed"; exit 1 }
    foreach ($f in @("index.ts", "tui.tsx", "package.json")) {
        Copy-Item (Join-Path $tmp $f) $pluginDir -Force
    }
    Copy-Item (Join-Path $tmp "lib") $pluginDir -Recurse -Force
    Say "plugin installed"
}

# ---- runtime --------------------------------------------------------------
Step "Runtime (whisper.cpp)"
if ($SkipRuntime) {
    Say "skipped (-SkipRuntime); expecting whisper-server.exe in $runtimeDir"
} else {
    $needsDownload = -not (Test-Path (Join-Path $runtimeDir "whisper-server.exe"))
    if ($flavour -eq "cuda") {
        # Upstream publishes CUDA builds for Windows.
        Say "downloading upstream CUDA build..."
        $zip = Join-Path $env:TEMP "whisper-cuda.zip"
        & curl.exe -L --fail --silent --show-error -o $zip "$WhisperSource/releases/latest/download/whisper-bin-win-cuda-12.4.0-x64.zip"
        if ($LASTEXITCODE -ne 0) { Say "CUDA download failed - see $WhisperSource/releases"; exit 1 }
        New-Item -ItemType Directory -Force $runtimeDir | Out-Null
        Expand-Archive -Path $zip -DestinationPath $runtimeDir -Force
        Get-ChildItem (Join-Path $runtimeDir "Release") -ErrorAction SilentlyContinue |
            ForEach-Object { Copy-Item $_.FullName $runtimeDir -Force }
        Say "CUDA runtime installed"
    } elseif ($flavour -eq "vulkan") {
        Say "Vulkan builds are not published upstream."
        Say "Download https://github.com/fahrim/whisper-vulkan-win and extract into:"
        Say "  $runtimeDir"
        Say "It must contain whisper-server.exe, whisper.dll and ggml-*.dll."
        $needsDownload = $false
    } else {
        Say "CPU build - download from $WhisperSource/releases into $runtimeDir"
        $needsDownload = $false
    }
    if ($needsDownload) { Say "runtime ready" }
}

# ---- model ----------------------------------------------------------------
Step "Model"
New-Item -ItemType Directory -Force $modelsDir | Out-Null
if ($SkipModel) {
    Say "skipped (-SkipModel); expecting $Model in $modelsDir"
} else {
    $modelPath = Join-Path $modelsDir $Model
    if (Test-Path $modelPath) {
        Say "cached: $modelPath"
    } else {
        Say "downloading $Model (this can take a few minutes)..."
        & curl.exe -L --fail --silent --show-error --retry 3 -o "$modelPath.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$Model"
        if ($LASTEXITCODE -ne 0) { Say "model download failed"; exit 1 }
        Move-Item -Force "$modelPath.part" $modelPath
        Say "model installed"
    }
}

# ---- config ---------------------------------------------------------------
Step "Configuration"
New-Item -ItemType Directory -Force $ConfigDir | Out-Null
$configFile = Join-Path $ConfigDir "opencode-voice-99.json"
$cfg = [ordered]@{
    ffmpeg       = "ffmpeg"
    runtime      = $runtimeDir
    model        = (Join-Path $modelsDir $Model)
    port         = 8801
    backend      = $Backend
    language     = $Language
    threads      = 0
    idleMinutes  = 10
    maxSeconds   = 300
    sampleRate   = 16000
    hotkey       = "ctrl+y"
    mic          = ""
}
[System.IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Say "config written: $configFile"

Write-Host ""
Write-Host "== Summary"
Say "plugin: $pluginDir"
Say "runtime: $runtimeDir"
Say "model:   $(Join-Path $modelsDir $Model)"
Say "config:  $configFile"
Say ""
Say "next steps:"
Say "  1. restart OpenCode"
Say "  2. run /voice-mic to pick your microphone"
Say "  3. press $((Get-Content $configFile -Raw | ConvertFrom-Json).hotkey) and speak"
Write-Host ""