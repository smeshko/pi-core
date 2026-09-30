# pi-core

Pi package with the resources shared by every profile (personal and work).
Loaded next to either `pi-personal` or `pi-work`.

| Path | Loaded by |
|---|---|
| `extensions/` | pi (package discovery: top-level `.ts` files, subdirs with `index.ts`) |
| `skills/`, `prompts/` | pi (package discovery) |
| `agents/` | `extensions/subagent`: package `agents/` < profile `agents/` < project `.pi/agents` |
| `mcp.json` | `extensions/mcp`: package `mcp.json` < profile `mcp.json` < project `.pi/mcp.json` |
| `AGENTS.md` | symlinked into each profile dir (`<agentDir>/AGENTS.md`) |

`extensions/shared/` has no `index.ts`, so pi does not load it as an extension.
`shared/package-roots.ts` resolves configured package roots from the profile's `settings.json`.

## Profiles

Each profile is a pi agent dir holding `settings.json`, `auth.json`, sessions and trust:

| Profile | Agent dir | Packages |
|---|---|---|
| work | `~/.pi/agent` (default) | `~/Developer/pi-core`, `~/Developer/rewe/pi-work` |
| personal | `~/.pi/agent-personal` | `~/Developer/pi-core`, `~/Developer/pi-personal` |

```bash
alias pi-personal='PI_CODING_AGENT_DIR=~/.pi/agent-personal pi'
```

## Development

```bash
npm install   # runtime deps (MCP SDK) + dev deps for tests
npm test      # runs every extensions/*/tests suite
```

Local-path packages load directly from this checkout; edits apply on the next `/reload` or restart.
