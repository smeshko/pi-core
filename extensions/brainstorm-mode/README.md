# Brainstorm Mode

A read-only, divergent-thinking mode toggled with **Tab**.

```
─── BRAINSTORM ──────────────────────────────────────────────
 > how should we handle offline booking sync?
──────────────────────────────────────────────────────────────
```

The border turns violet and gains a headline. Press Tab again to return to
normal mode.

## Tab

Tab cycles modes whenever the base editor would have had nothing to complete:

| Buffer | Tab does |
|---|---|
| empty | switch mode |
| `how should we handle sync` | switch mode |
| `look at @lib/main` | complete the path |
| `/rel` | complete the slash command |
| autocomplete popup open | navigate/apply the completion |

So you can switch with a half-written prompt in the field, and `@path` /
`/command` completion still works. The rule: claim Tab unless the token before
the cursor is path-like (`@`, `~`, `.`, or contains `/`) or an unfinished slash
command.

This is why the mode uses a custom editor rather than `pi.registerShortcut("tab")`:
`CustomEditor.handleInput` consults extension shortcuts first and returns as soon
as one matches, with no fall-through, so a registered Tab shortcut would swallow
autocomplete globally.

Tab pressed mid-turn queues the switch until the agent settles.

## The border color

`editor.borderColor` is *live* on the app side - `interactive-mode.js:3076-3080`
reassigns it whenever the thinking level or bash mode changes. So the editor
installs an accessor over it rather than snapshotting: the app keeps writing
whatever it wants into the setter, brainstorm mode wins on read while active, and
normal mode reads back the app's *current* color. Snapshotting at construction
left the border stuck on a stale color after exiting.

## What brainstorm mode can do

| Allowed | Denied |
|---|---|
| `read` `grep` `find` `ls` | `bash` |
| `askUserQuestion` | `edit` `write` |
| `websearch` `webfetch` | mutating MCP tools |
| `subagent` (constrained) | everything else, fail-closed |
| `search_mcp_tools` + read-only `mcp__*` | |
| `brainstorm_save` | |

## How read-only is enforced

Prose is not enforcement. Four layers, in descending order of reliability:

1. **Tool absence.** `pi.setActiveTools()` intersects the previously active set
   with the allowlist, so write tools are not in the schema at all. The set is
   only ever narrowed, never widened.
2. **Call-time block.** The `tool_call` hook re-checks every call. This is not
   redundant: the MCP loader calls `pi.setActiveTools()` *additively* mid-turn
   (`mcp/index.ts:134`), so tools can appear after the mode was entered. A
   `tool_result` hook re-narrows the set after `search_mcp_tools` runs.
3. **Argument coercion.** See subagent below.
4. **System prompt.** Appended in `before_agent_start` as real system-role text,
   so it vanishes cleanly when the mode is left - no stale-context filtering
   needed. It shapes behaviour; it does not enforce it.

### Subagents

`subagent`'s runner resolves child tools as `taskTools ?? agent.tools ?? defaultTools`,
so a model-supplied `tools` array **overrides** the agent's frontmatter. Frontmatter
alone is therefore not a guarantee.

The guard:

- allows only `explore` and `webfetch`;
- **overwrites** `tools` on the top-level call and on every `tasks[]`/`chain[]`
  entry with that agent's read-only set, discarding whatever the model asked for;
- strips `runtime` overrides.

Children are spawned as `pi -p --no-session --tools read,grep,find,ls`, enforced
by argv rather than by prompting.

### MCP

Tool names are `mcp__<server>__<remote>`. The MCP extension does not retain the
server's `annotations.readOnlyHint`, so classification is name-based and
**fail-closed**:

- a write verb anywhere in the name loses (`wit_get_or_create_work_item` is denied);
- a read verb must be present to win (`wit_get_work_item`, `repo_list_pull_requests`);
- anything else is denied, and the block reason names the tool.

To force-allow a misclassified read-only tool, add its remote name to
`EXTRA_ALLOWED_MCP_TOOLS` in `index.ts`.

## Asking questions

The interrogation doctrine is the `grilling` skill, inlined rather than invoked
(it is instruction text with no scripts, so inlining removes any dependence on the
model choosing to load it): map the problem as a **design tree**, work it in
**rounds**, ask the whole **frontier** each round, dispatch subagents for facts
rather than asking the user, stop when the frontier is empty.

The one adaptation is delivery. The skill's `❓ Q1 ... ➡️ recommendation` prose
format becomes **one `askUserQuestion` call per round, one tab per frontier
question**, with the recommended option marked as such and trade-offs in the
option descriptions. The prompt forbids prose questions in strong terms.

## The running document

There is no exit dialog. The agent maintains a living document *during* the
brainstorm - created as soon as the problem is framed, rewritten after every round
and whenever a decision settles - so leaving simply confirms where it landed:

```
Brainstorm saved to .agents/brainstorms/2026-06-11-offline-sync.md
```

`brainstorm_save` is an **upsert**: the first call pins the file, every later call
overwrites that same file, so the directory gets one document per brainstorm
rather than a pile of snapshots. The model passes the complete document each time.

If a brainstorm somehow ends with no document at all, Tab-out runs a single silent
capture turn first, then flips - so nothing is lost, and you are never asked a
question on the way out.

## `brainstorm_save`

The only write primitive in the mode. Path-clamped to
`.agents/brainstorms/<YYYY-MM-DD>-<slug>.md`; the model supplies a slug and
markdown, never a path, and the slug is sanitized (`../../etc/passwd` becomes
`etc-passwd`).

Renders in the house style from `../shared/tool-render-style.ts`:

```
● BrainstormSave(2026-06-11-offline-sync.md)
└─ Updated · 5 sections · 82 lines (ctrl+o to expand)
```

## Adding a third mode

`modes.ts` is a list, and Tab cycles `(index + 1) % MODES.length`. A converging
"plan" mode is one entry plus its tool policy - no control-flow changes elsewhere.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Mode state, hooks, persistence, exit flow |
| `modes.ts` | Mode registry |
| `editor.ts` | Tab handling, border accessor, headline |
| `guards.ts` | Allowlist, MCP classification, subagent coercion |
| `save-tool.ts` | `brainstorm_save` upsert + rendering |
| `prompt.ts` | System prompt block |

## Development

```bash
npm test          # 30 tests
npm run typecheck
```

State persists across `/resume` via `appendEntry`/`session_start`, including the
pre-mode active-tool list so exit restores exactly rather than guessing, and the
pinned document path so a resumed brainstorm keeps writing to the same file.
