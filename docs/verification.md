# Verification

This server is a Claude-facing wrapper around Microsoft's official `powerbi-modeling-mcp`.

## What was verified locally

- MCP server starts over stdio and returns its tool list.
- `list_semantic_models_in_workspace` launches Microsoft's native `powerbi-modeling-mcp` binary.
- The Microsoft bridge can connect to workspace `test-mcp`.
- The Microsoft bridge returns semantic models `codex` and `hospital` from `test-mcp`.

## Authentication model

This project does not expose Power BI REST catalog tools and does not run a device-code login flow itself.

Authentication is delegated to the local Microsoft `powerbi-modeling-mcp` process configured by:

- `POWERBI_MODELING_MCP_COMMAND`
- `POWERBI_MODELING_MCP_ARGS`

The default args are:

```bash
--start --authmode=interactive
```

Workspace discovery is intentionally limited to explicit workspace names passed to `list_semantic_models_in_workspace` or configured in `POWERBI_KNOWN_WORKSPACES`.
