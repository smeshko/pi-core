# bg-jobs

Background bash execution for pi. The agent starts commands in the background
and **keeps talking to you** while they run; you inspect and kill them through
an interactive overlay.

Implements `.agents/brainstorms/2026-09-04-background-bash-execution.md`.

## The one rule

**These tools never block the agent turn.** `bg_run` returns immediately. When a
job finishes you get a toast and the agent gets a queued message it reads on its
next turn. Nothing waits.

Work that genuinely needs to block belongs in the built-in `bash` tool, which
already does it in one call.

## Human surface

| Trigger | Behaviour |
|---|---|
| `ctrl+alt+b` | Picker (2+ jobs), or detail view directly (exactly 1 job). Silent no-op with 0 jobs. |
| `/bg` | Same as `ctrl+alt+b`. |
| `/bg kill <id-or-name>` | Non-interactive kill. |

In the detail view: `↑↓` scroll · `←` back to the list · `x` kill · `esc`/`enter`/`space` close.

A widget above the editor shows `● N background jobs running` while any job is
alive, and clears when none remain.

## LLM tools

| Tool | Purpose |
|---|---|
| `bg_run(command, name?, cwd?)` | Spawn in background, return immediately. |
| `bg_status(job)` | State plus the last 100 output lines, as of right now. |
| `bg_list()` | Every job this session, running and finished. |
| `bg_kill(job)` | SIGTERM, 3s grace, then SIGKILL. |

Jobs resolve by id (`job-1`) or by name. Duplicate names get a `-2` suffix.

## On completion

A single `bg-job-finished` custom message is sent with `triggerTurn: true`. It
uses the house tool renderer and carries the last 20 output lines. The agent
starts a turn immediately when idle, or pi steers the current run when the agent
is already streaming, so failed or successful background work is acted on
without waiting for another user prompt.

There is deliberately no `ctx.ui.notify` call: pi renders that as a separate
grey status line in the transcript, duplicating the house-style completion row.

**Do not use `deliverAs: "nextTurn"` here.** That queue is only flushed on the
fresh-prompt path. When the user types while the agent is streaming, the message
goes through the steering path instead, so `nextTurn` can silently remain
undelivered during the workflow background jobs exist for.

## Lifecycle

- `session_start` creates `$TMPDIR/pi-bg-<sessionId>/` and sweeps dirs from dead
  pi processes. Liveness is checked via an `owner.pid` marker, so concurrent pi
  sessions are never disturbed; ownerless dirs fall back to a 24h age cutoff.
- `session_shutdown` kills every running job and deletes the temp dir. Those
  kills are suppressed from the completion path — no toast storm on exit.

Output goes to both `<job>.log` and a 1000-line in-memory ring buffer. The UI
reads the buffer, so an already-exited job still renders its tail.

**ANSI escapes are stripped on the way into the ring buffer.** Shell output is
full of colour codes; components fill rows with a background colour, and an
embedded SGR reset tears that fill mid-line (visible as a ragged, half-coloured
block in the transcript). They are also pure token noise in the LLM's context.
The log file keeps the raw bytes, so `less -R` still shows colour.

The completion message renders through `registerMessageRenderer` in the same
house style as tool rows (`● BackgroundTask(tests)` + `└─ exited (0) · 2m 29s`),
rather than pi's default custom-message block.

## Shared overlay plumbing

The picker (2+ jobs) and detail (scroll/kill/back) overlays are built on
`../shared/overlay.ts`, not reimplemented locally. That module is shared with
the `subagent` extension's job UI (`ctrl+alt+a`), so both features present the
same list-then-detail navigation, the same key handling, and the same scroll
math. `panel.ts` in this directory (a thick double-border box style) is unrelated chrome that neither overlay currently uses;
it is kept only because its own test (`tests/panel.test.ts`) still exercises it.

## Deviations from the brainstorm

**`bg_wait` was removed** (overturns Decision 8). Once a tool blocks the turn,
`bg_run` + `bg_wait` is just `bash` with extra steps — and its description
actively invited the blocking behaviour the feature exists to prevent. Sequential
or blocking work goes to `bash`. Completion notifications cover the rest.

**Keybinding is `ctrl+alt+b`, not `ctrl+b`** (overturns Decision 13/14). The spec
weighed `ctrl+b` only against tmux. It is also pi's own default binding for
`tui.editor.cursorLeft` — an unconditional collision hitting every user in every
terminal, exactly where the spec wanted the shortcut live.

**Detail-view back navigation is labelled, not uniform.** Decision 15 (single job
skips the list) means `←` has nothing to return to in that case, so the footer
only advertises `← back` when a list exists.

## Known limitations

- **Grandchildren can survive a kill.** Jobs spawn under `sh -c` with
  `detached: false` per the spec. For pipelines or backgrounded subshells,
  killing `sh` can leave children behind.
- **Ungraceful pi exit leaks processes.** A crash or `kill -9` skips
  `session_shutdown`; orphaned jobs keep running and only their log dirs are
  reclaimed by the next session's sweep. Accepted in the brainstorm.
- **Output beyond 1000 lines** is only in the log file, not the overlay.

## Development

```bash
npm test        # 39 tests: process layer, extension wiring, panel geometry
npm run typecheck
```

`jobs.ts` is deliberately free of TUI and ExtensionAPI imports so it can be
tested standalone. `tests/extension.test.ts` imports the real module graph, so a
broken import fails there instead of breaking pi at startup.
`tests/panel.test.ts` enforces the TUI width contract.

Rendering follows the house style in `../shared/tool-render-style.ts`
(`● BackgroundTask(...)` + `└─ summary`) and every tool sets
`renderShell: "self"` — without that, pi wraps each row in its own box and
background, which clashes with the house style. Overlays use the thick-bordered
panel style.
