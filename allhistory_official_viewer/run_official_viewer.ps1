param(
  [int]$Port = 8898,
  [string]$HostName = "127.0.0.1",
  [string]$PublicOrigin = "",
  [string]$CacheDir = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$env:PORT = "$Port"
$env:HOST = $HostName
if ($PublicOrigin) { $env:PUBLIC_ORIGIN = $PublicOrigin }
if ($CacheDir) { $env:AH_CACHE_DIR = $CacheDir }

Write-Host "AllHistory official viewer starting: http://$HostName`:$Port"
if ($PublicOrigin) { Write-Host "Public origin: $PublicOrigin" }
node .\server.mjs
