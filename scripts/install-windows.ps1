param(
  [string]$Workspace = "GSM_MCP_POC_WORKSPACE",
  [string]$RepoDir = "$HOME\mcp-powerBI-to-report",
  [switch]$CorporateNpm,
  [switch]$Clean,
  [switch]$SkipPrereqInstall
)

$ErrorActionPreference = "Stop"

function Command-Exists($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Try-WingetInstall($Id) {
  if ($SkipPrereqInstall) { return }
  if (-not (Command-Exists winget)) { return }
  winget install --id $Id -e --source winget
  Refresh-Path
}

if (-not (Command-Exists git)) {
  Write-Host "Git not found. Trying winget install..."
  Try-WingetInstall "Git.Git"
}
if (-not (Command-Exists node)) {
  Write-Host "Node.js not found. Trying winget install..."
  Try-WingetInstall "OpenJS.NodeJS.LTS"
}
Refresh-Path

if (-not (Command-Exists git)) {
  throw "Git is not available. Install Git or ask IT to install Git, then re-run this command."
}
if (-not (Command-Exists npm)) {
  throw "npm is not available. Install Node.js LTS or ask IT to install Node.js LTS, then re-run this command."
}

if (!(Test-Path "$RepoDir\.git")) {
  git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git $RepoDir
} else {
  Set-Location $RepoDir
  git pull
}

Set-Location $RepoDir

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($Clean -or $CorporateNpm) {
  if (Test-Path .\node_modules) {
    try {
      Remove-Item -Recurse -Force .\node_modules -ErrorAction Stop
    } catch {
      $backup = "node_modules.bak.$(Get-Date -Format yyyyMMddHHmmss)"
      Write-Host "Could not fully remove node_modules. Trying to rename it to $backup ..."
      Rename-Item .\node_modules $backup -ErrorAction Stop
    }
  }
}

if ($CorporateNpm) {
  $env:npm_config_strict_ssl = "false"
  npm cache clean --force
}

npm install --omit=dev --include=optional
powershell -ExecutionPolicy Bypass -File .\scripts\setup-claude-desktop.ps1 -Workspace $Workspace -SkipInstall

Write-Host ""
Write-Host "Done. Restart Claude Desktop completely, then ask Claude:"
Write-Host "Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup."
