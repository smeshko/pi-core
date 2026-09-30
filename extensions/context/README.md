# Context Extension for Pi

Adds `/context`, a breakdown of where the context window is going plus an inventory of everything customizing the current session. Output is written to the transcript as a custom entry, so it stays in scrollback and never enters the LLM context.

## Install

Auto-discovered from `~/.pi/agent/extensions/context/index.ts`. Run `/reload` after changes.

## What it shows

| Section | Source |
|---|---|
| Block grid + category legend | `ctx.getContextUsage()` for the total, local chars/4 estimates for the split |
| MCP tools | `mcp:registry:request` event to the MCP extension, falling back to `mcp__<server>__` name parsing |
| Memory files | Recursive scan for `AGENTS.md` / `CLAUDE.md` under cwd, plus ancestors and the agent dir; split into in-context and nested |
| Extensions | Directory scan cross-referenced with `sourceInfo.path` from `getAllTools()` / `getCommands()` |
| Skills | `getSystemPromptOptions().skills`, grouped by scope |
| Commands | `pi.getCommands()`, extension and prompt sources only (skills have their own section) |
| Agents | `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` frontmatter |
| Keybindings | `keybindings.json` overrides, default table count, and `registerShortcut` calls parsed from extension sources |
| Themes | `ctx.ui.getAllThemes()` |

## Token accounting

Only the **total** is measured; the provider reports it through normalized usage. Category splits are estimates at chars/4, matching pi's own `estimateTokens` heuristic.

```
messages = measuredTotal - (systemPrompt + toolSchemas + mcpTools + contextFiles + skills)
```

The footer prints `measured · estimated · Δ` so drift is always visible. When no provider total exists yet — a fresh session, or right after compaction — the header switches to "Estimated usage (no provider total yet)" and messages are estimated from the session branch instead.

System-prompt slices are subtracted rather than double counted: context files and skill metadata are embedded *inside* the system prompt, so `System prompt` reports the remainder after removing them.

## Notes

- `KeybindingsManager` is not exported from the package root. The extension locates the pi package by walking up from `process.argv[1]` and imports the internal module by absolute path, degrading to overrides-only if that fails.
- Extension shortcuts are not exposed by the extension API either, so `registerShortcut(...)` calls are parsed out of extension sources. Shortcuts implemented by intercepting keys in a custom editor (plan-mode's Tab) cannot be detected this way.
- Memory-file scanning skips `node_modules`, build output, and VCS directories, stops at depth 8, and caps at 200 files.
- Tool schema tokens count only *active* tools. Registered-but-inactive MCP tools appear under "Available" with the tokens they would cost.
- Output is descriptive only; it reports what pi loaded without flagging what it did not.

## Files

| File | Role |
|---|---|
| `index.ts` | `/context` command and transcript entry renderer |
| `src/collect.ts` | Data gathering and token estimation |
| `src/render.ts` | Grid, legend, and section layout |
