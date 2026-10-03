# Pokreće relay + RapidRAW Web Bridge na Windowsu.
#   $env:RR_PHOTOS="D:\Photos"; .\run.ps1
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Id = "io.github.vedranius.rapidrawweb"
if (-not $env:RR_PHOTOS) { throw "Postavi `$env:RR_PHOTOS na folder s fotografijama" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20+ nije instaliran" }

$Bin = $env:RR_BRIDGE_BIN
if (-not $Bin) {
  $cands = @(
    (Join-Path $Here "..\src-tauri\target\release\rapidraw-web-bridge.exe"),
    (Join-Path $env:LOCALAPPDATA "RapidRAW Web Bridge\rapidraw-web-bridge.exe"),
    (Join-Path $env:ProgramFiles "RapidRAW Web Bridge\rapidraw-web-bridge.exe")
  )
  $Bin = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Bin) { throw "Ne nalazim rapidraw-web-bridge.exe (postavi `$env:RR_BRIDGE_BIN)" }

$Data = Join-Path $env:APPDATA $Id; $Cache = Join-Path $env:LOCALAPPDATA $Id
New-Item -ItemType Directory -Force -Path $Data, $Cache | Out-Null
if (-not $env:RR_ROOTS) { $env:RR_ROOTS = "$($env:RR_PHOTOS);$Data;$Cache" }
if (-not $env:RR_CONFIG) { $env:RR_CONFIG = Join-Path $Data "rrweb.json" }

$relay = Start-Process node -ArgumentList "`"$Here\relay\relay.mjs`"" -NoNewWindow -PassThru
Start-Sleep -Milliseconds 500
$app = Start-Process $Bin -PassThru
try { Wait-Process -Id $app.Id } finally { Stop-Process -Id $relay.Id -ErrorAction SilentlyContinue }
