# Power BI MCP POC Checklist

Use this checklist before handing the setup to a new user.

## 1. Installer coverage

- macOS: run `bash scripts/setup-claude-desktop.sh --workspace <workspace>`.
- Windows Git Bash: run the same bash command.
- Windows PowerShell: run `powershell -ExecutionPolicy Bypass -File scripts\setup-claude-desktop.ps1 -Workspace <workspace>`.
- PowerShell download must use `Invoke-WebRequest` or `iwr`, not `curl -fsSL`.

## 2. MCP activation diagnostics

In Claude, run:

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
```

The expected checks are:

- `localMcpServerLoaded: true`
- `usesRemoteMcpEndpoint: false`
- `usesRestDeviceLogin: false`
- `modelingMcp.authMode: interactive`
- `modelingMcp.commandExists: true`

If the MCP is installed but not active, restart Claude Desktop completely and verify the Claude config contains:

```json
{
  "command": "node",
  "args": ["...\\mcp-powerBI-to-report\\dist\\server.js"]
}
```

## 3. Authentication rule

This project does not run REST/device-login authentication.

Authentication must be delegated to Microsoft `powerbi-modeling-mcp` with:

```text
--start --authmode=interactive
```

The user must authenticate with the required company account when Microsoft Modeling MCP prompts for login.

## 4. E2E verification

Run these from Claude:

```text
Use mcp-powerBI-to-report to list semantic models in workspace <workspace>.
```

Then:

```text
Use mcp-powerBI-to-report to execute DAX query:
EVALUATE ROW("Test", 1)
on semantic model <model>.
```

Then:

```text
Use mcp-powerBI-to-report to execute a report query and return both text and HTML.
```

## 5. Chart and report output rules

The report generator should choose the display from the actual returned data shape:

- time column + numeric metric: trend or month-extreme block
- category + numeric metric: ranking/contribution block
- two dimensions + numeric metric: cross-dimension pocket block
- multiple independent semantic models: source-separated evidence blocks
- shallow one-row result: KPI/scorecard block
- unsupported shape: evidence table with clear limitations

Do not force all returned data into one chart.

## 6. Claude display check

For every POC report, verify:

- text summary is returned
- structured rows are returned
- HTML resource is returned
- generated file path exists
- chart blocks do not overflow on Claude's preview width
- tables remain readable when there are many columns
