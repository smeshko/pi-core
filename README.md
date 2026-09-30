# pi-core

Functional pi resources: what the agent can do. Shareable on its own.
Look-and-feel lives in [pi-taste](https://github.com/smeshko/pi-taste), which depends on this package.

| Path | Loaded by |
|---|---|
| `extensions/` | pi (package discovery: top-level `.ts` files, subdirs with `index.ts`) |
| `skills/`, `prompts/` | pi (package discovery) |
| `agents/` (none here) | `extensions/subagent` reads `agents/` from any package: package < profile < project `.pi/agents`. Agents pin models, so they live in pi-personal / pi-work |
| `mcp.json` | `extensions/mcp`: package `mcp.json` < profile `mcp.json` < project `.pi/mcp.json` |
| `AGENTS.md` | symlinked into each profile dir (`<agentDir>/AGENTS.md`) |

`extensions/shared/` has no `index.ts`, so pi does not load it as an extension.
`shared/package-roots.ts` resolves configured package roots from the profile's `settings.json`.

## Profiles

Each profile is a pi agent dir holding `settings.json`, `auth.json`, sessions and trust:

| Profile | Agent dir | Packages |
|---|---|---|
| work | `~/.pi/agent` (default) | pi-core, pi-taste, `~/Developer/rewe/pi-work` |
| personal | `~/.pi/agent-personal` | pi-core, pi-taste, pi-personal |
| colleague | their own | pi-core (+ their own packages) |

```bash
alias pi-personal='PI_CODING_AGENT_DIR=~/.pi/agent-personal pi'
```

## Development

```bash
npm install   # runtime deps (MCP SDK) + dev deps for tests
npm test      # runs every extensions/*/tests suite
```

Local-path packages load directly from this checkout; edits apply on the next `/reload` or restart.
