# MCP Extension for Pi

Adds Model Context Protocol support to pi. MCP configuration is read at session start, but servers remain stopped until the model calls `search_mcp_tools` or the user runs `/mcp`. Their tools are then registered with pi and loaded on demand.

Pi has no built-in MCP support by design; this extension is the bridge.

## Install

```bash
cd ~/.pi/agent/extensions/mcp
npm install
```

Pi auto-discovers `~/.pi/agent/extensions/mcp/index.ts`. Restart pi or run `/reload`.

## Configuration

Servers are declared in `mcp.json`:

| Path | Scope |
|------|-------|
| `~/.pi/agent/mcp.json` | Global |
| `<project>/.pi/mcp.json` | Project-local, only loaded when the project is trusted |

Project entries override global entries with the same name.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"]
    },
    "ado": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${ADO_TOKEN}" }
    },
    "legacy": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

### Fields

| Field | Applies to | Description |
|-------|-----------|-------------|
| `type` | all | `stdio`, `http`, or `sse`. Inferred: `url` present → `http`, otherwise `stdio`. |
| `command` | stdio | Executable to spawn. Required for stdio. |
| `args` | stdio | Arguments array. |
| `env` | stdio | Extra environment variables. Merged over the inherited environment. |
| `cwd` | stdio | Working directory for the server process. |
| `url` | http, sse | Endpoint URL. Required. |
| `headers` | http, sse | Extra request headers, e.g. auth tokens. |
| `enabled` | all | Set `false` to keep the entry but skip connecting. |
| `includeTools` | all | Allowlist of server-side tool names. |
| `excludeTools` | all | Blocklist of server-side tool names. |
| `timeout` | all | Connect/list/call timeout in ms. Default `30000`. |

`$VAR` and `${VAR}` in `command`, `args`, `env`, `url`, and `headers` are interpolated from the environment. Unknown variables become empty strings, so secrets never need to live in the config file.

## How tools are exposed

MCP tools are registered as `mcp__<server>__<tool>` but start **inactive**, so they cost no system-prompt tokens. The model activates what it needs:

```
search_mcp_tools({ query: "create a pull request", server?: "...", limit?: 5 })
```

This uses pi's dynamic tool loading, so on Anthropic 4.5+/GPT-5.4+ the definitions load without invalidating the cached prompt prefix.

### Ranking

`src/search.ts` ranks tools so that a query about one server does not drag in another's tools:

- **Filler is dropped** (`STOPWORDS`) and operation verbs (`list`, `get`, `create`, …) count half, so "list all pipelines" is scored as a query about pipelines.
- **Rare terms win**: term weight is inverse document frequency over the connected corpus, so words most tools share (`project`, `data`) cannot decide a match.
- **Fields are weighted**: tool name > server name > description, and scores are normalized by query weight so verbose descriptions gain nothing from length.
- **Server affinity**: terms that identify one server (`azure`, `figma`) lift that server's tools. Those same terms are ignored in description scoring, since they sit in every description that server ships.
- **The long tail is cut**: matches below 40% of the best score are dropped rather than padded up to `limit`. Only the single best match survives a query nothing really fits.

`tests/fixtures.ts` holds a real `tools/list` capture, so ranking changes are checked against actual server inventories.

## Commands

| Command | Effect |
|---------|--------|
| `/mcp` | Lazily connect, then show server status, tool counts, and how many tools are active |
| `/mcp reload` | Disconnect everything, re-read `mcp.json`, and reconnect |
| `/mcp load <server\|tool>` | Activate a server's tools (or one tool) without asking the model |

## Behavior notes

- Server processes and handshakes are fully lazy, so MCP does not block normal startup or consume resources until requested.
- Concurrent searches share one connection attempt; connection failures and malformed config entries are reported as warnings.
- Servers are closed in `session_shutdown`, including across `/new`, `/resume`, and `/reload`.
- Tool errors from MCP (`isError: true`) are thrown so pi reports them to the model as failures.
- Image and resource content blocks are summarized as text placeholders.

## Files

| File | Role |
|------|------|
| `index.ts` | Extension wiring: registration, loader tool, `/mcp` command, lifecycle |
| `src/config.ts` | `mcp.json` discovery, env interpolation, validation |
| `src/client.ts` | Transport construction, connection, `tools/list`, `tools/call` |
| `src/search.ts` | Query tokenization and relevance ranking for `search_mcp_tools` |
| `src/tools.ts` | Tool naming and JSON Schema normalization |
