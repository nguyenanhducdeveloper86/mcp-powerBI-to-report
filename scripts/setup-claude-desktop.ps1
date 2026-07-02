param(
  [string]$Workspaces = $env:POWERBI_KNOWN_WORKSPACES,
  [string]$Workspace = $env:POWERBI_DEFAULT_WORKSPACE,
  [string]$Model = $env:POWERBI_DEFAULT_SEMANTIC_MODEL,
  [string]$ReportDir = $env:POWERBI_REPORT_OUTPUT_DIR,
  [string]$Config = "",
  [string]$Name = "mcp-powerBI-to-report",
  [string]$ModelingCommand = $env:POWERBI_MODELING_MCP_COMMAND,
  [string]$ModelingArgs = $env:POWERBI_MODELING_MCP_ARGS,
  [switch]$SkipInstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Resolve-CommandSource($Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Missing required command: $Name"
  }
  if ($command.Source) {
    return $command.Source
  }
  return $command.Path
}

function Assert-NodeAndNpmVersion {
  $nodeVersionText = (& node -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "node failed." }
  $nodeMajor = [int](($nodeVersionText -replace '^v', '').Split('.')[0])
  if ($nodeMajor -lt 18) {
    throw "Node.js 18 or newer is required. Current: $nodeVersionText"
  }

  $npmVersionText = (& npm -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "npm failed." }
  $npmMajor = [int]($npmVersionText.Split('.')[0])
  if ($npmMajor -lt 9) {
    throw "npm 9 or newer is required. Current: $npmVersionText"
  }
}

function First-CsvValue($Value) {
  if (-not $Value) { return "" }
  return (($Value -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
}

function Get-ClaudeConfigPath {
  if ($Config) { return $Config }

  $standard = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $packages = Join-Path $env:LOCALAPPDATA "Packages"
  if (Test-Path $packages) {
    $msix = Get-ChildItem $packages -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($msix) {
      $candidate = Join-Path $msix.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"
      if (Test-Path $candidate) { return $candidate }
    }
  }
  return $standard
}

function Resolve-ModelingCommand($RepoDir, $RequestedCommand) {
  if ($RequestedCommand) {
    if ($RequestedCommand -match '(^|\\)npx(\.cmd)?$' -or $RequestedCommand -eq 'npx' -or $RequestedCommand -eq 'npx.cmd') {
      $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
      if (-not $npxCommand) {
        $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
      }
      if (-not $npxCommand) {
        throw "Cannot find npx or npx.cmd on PATH."
      }
      return $npxCommand.Source
    }
    if (-not (Test-Path $RequestedCommand) -and -not (Get-Command $RequestedCommand -ErrorAction SilentlyContinue)) {
      throw "Configured POWERBI_MODELING_MCP_COMMAND was not found: $RequestedCommand"
    }
    return $RequestedCommand
  }

  $nativeBinary = Join-Path $RepoDir "node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe"
  if (Test-Path $nativeBinary) {
    return $nativeBinary
  }

  $localShim = Join-Path $RepoDir "node_modules\.bin\powerbi-modeling-mcp.cmd"
  if (Test-Path $localShim) {
    return $localShim
  }

  $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  }
  if ($npxCommand) {
    return $npxCommand.Source
  }

  throw "Cannot find a usable Modeling MCP command. Tried native .exe, local .cmd shim, and npx."
}

Require-Command node
Require-Command npm
Assert-NodeAndNpmVersion
$NodeCommand = Resolve-CommandSource "node"

$RepoDir = Split-Path -Parent $PSScriptRoot
if (-not $Workspaces -and $Workspace) {
  $Workspaces = $Workspace
}
if (-not $Workspaces) { $Workspaces = "test-mcp" }
if (-not $Workspace) { $Workspace = First-CsvValue $Workspaces }
if (-not $ReportDir) { $ReportDir = Join-Path $HOME "powerbi-report-output" }
if (-not $ModelingArgs) { $ModelingArgs = "--start --authmode=interactive" }

Set-Location $RepoDir

if (-not $SkipInstall -and -not $DryRun) {
  npm install --omit=dev --include=optional
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
}

$ModelingCommand = Resolve-ModelingCommand $RepoDir $ModelingCommand
if ($ModelingCommand.ToLower().EndsWith("npx.cmd") -or $ModelingCommand -eq "npx") {
  if (-not $env:POWERBI_MODELING_MCP_ARGS -and -not $PSBoundParameters.ContainsKey("ModelingArgs")) {
    $ModelingArgs = "-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive"
  }
}

$ConfigPath = Get-ClaudeConfigPath
$ServerJs = Join-Path $RepoDir "dist\server.js"

if ($DryRun) {
  [ordered]@{
    Repo = $RepoDir
    ClaudeConfig = $ConfigPath
    NodeCommand = $NodeCommand
    ServerJs = $ServerJs
    ModelingCommand = $ModelingCommand
    ModelingArgs = $ModelingArgs
    KnownWorkspaces = $Workspaces
    DefaultWorkspace = $Workspace
    DefaultSemanticModel = $Model
    ReportDir = $ReportDir
  } | Format-List
  exit 0
}

if (-not (Test-Path $ServerJs)) {
  throw "Missing prebuilt server: $ServerJs. Use the GitHub main branch that includes dist/server.js, or run npm install && npm run build on a development machine."
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null

if (Test-Path $ConfigPath) {
  Copy-Item $ConfigPath "$ConfigPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
  $raw = (Get-Content $ConfigPath -Raw).Trim()
  if ($raw) {
    $configObject = $raw | ConvertFrom-Json
  } else {
    $configObject = [pscustomobject]@{}
  }
} else {
  $configObject = [pscustomobject]@{}
}

$configMap = @{}
foreach ($property in $configObject.PSObject.Properties) {
  $configMap[$property.Name] = $property.Value
}
if (-not $configMap.ContainsKey("mcpServers") -or -not $configMap["mcpServers"]) {
  $configMap["mcpServers"] = [pscustomobject]@{}
}

$mcpServers = @{}
foreach ($property in $configMap["mcpServers"].PSObject.Properties) {
  $mcpServers[$property.Name] = $property.Value
}

$envMap = [ordered]@{
  POWERBI_KNOWN_WORKSPACES = $Workspaces
  POWERBI_DEFAULT_WORKSPACE = $Workspace
  POWERBI_MODELING_MCP_COMMAND = $ModelingCommand
  POWERBI_MODELING_MCP_ARGS = $ModelingArgs
  POWERBI_REPORT_OUTPUT_DIR = $ReportDir
}
if ($Model) {
  $envMap["POWERBI_DEFAULT_SEMANTIC_MODEL"] = $Model
}

$mcpServers[$Name] = [ordered]@{
  command = $NodeCommand
  args = @($ServerJs)
  env = $envMap
}
$configMap["mcpServers"] = $mcpServers

$configMap | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
(Get-Content $ConfigPath -Raw | ConvertFrom-Json) | Out-Null

$envPath = Join-Path $RepoDir ".env"
$envLines = @("# Generated by scripts/setup-claude-desktop.ps1")
foreach ($item in $envMap.GetEnumerator()) {
  $jsonValue = $item.Value | ConvertTo-Json -Compress
  $envLines += "$($item.Key)=$jsonValue"
}
$envLines += ""
$envLines | Set-Content -Path $envPath -Encoding UTF8

if (-not (Test-Path $envPath)) {
  throw "Failed to write .env file: $envPath"
}

Write-Host "Claude Desktop config updated: $ConfigPath"
Write-Host "Local env written: $envPath"
Write-Host "Restart Claude Desktop completely, then use MCP server: $Name"
