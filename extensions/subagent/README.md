# Pi Subagent Extension

Delegate work to named subagents that run in separate `pi --mode json -p --no-session` subprocesses with isolated context windows.

**Runs in the background by default.** Calling `subagent` (single, parallel, or chain — all modes) returns immediately with a job id. The whole call runs as one background job; when it finishes, the result is delivered as a message that wakes the agent up, exactly like the `bg_run` family in the sibling `bg-jobs` extension. There is no blocking variant — a fast synchronous preflight (unknown agent names, invalid params, recursion limits, project-agent confirmation) still runs before backgrounding, so obvious mistakes fail immediately instead of waiting for a job id to come back.

> **Important safety warning:** this hardened extension loads both `~/.pi/agent/agents/*.md` and the nearest project `.pi/agents/*.md` by default. Project agents are repo-controlled prompts. With the default child tool policy, a project agent can ask its child Pi process to read files, run bash, or edit files using normal Pi defaults unless you restrict it with `tools` or runtime config. Only use this default in repositories you trust.

## Human surface

| Trigger | Behaviour |
|---|---|
| `ctrl+alt+a` | Picker (2+ running/finished jobs), or detail view directly (exactly 1 job). Silent no-op with 0 jobs. |
| `/subagents` | Lists discovered agent *definitions* (scout/planner/...), not job instances — unchanged from before. |

The detail view: `↑↓` scroll · `←` back to the list · `x` cancel (aborts the child process(es)) · `esc`/`enter`/`space`/`q` close.

A footer widget shows `● N subagents running` while any job is alive; it sits on the line right after background bash jobs (`bg-jobs`), or takes that line itself when no bash jobs are running.

This whole overlay (picker + detail + navigation) is built on `../shared/overlay.ts`, the same primitives the `bg-jobs` extension uses, so both features share one interface end to end.

## Installation

This workspace lives at:

```bash
~/.pi/agent/extensions/subagent/index.ts
```

Pi auto-discovers extensions under `~/.pi/agent/extensions/*/index.ts`. For a one-off startup smoke test:

```bash
pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts --list-models
```

Sample agents are installed under `~/.pi/agent/agents/` and workflow prompts under `~/.pi/agent/prompts/`.

## Usage

Single agent:

```text
Use the subagent tool with agent scout to inspect the auth code.
```

The tool call returns almost instantly with something like:

```text
Started agent-1 (scout) [single].

Running in the background — you will be told when it finishes. Do not wait on it.
```

The model should end its turn here. When the child process finishes, pi delivers a `Subagent agent-1 (scout) completed after 8s.` message with the full result — rendered the same rich way the (previously blocking) tool result used to look, including per-agent activity, tool calls, and final output — and starts a new turn automatically.

Parallel agents (max 8 tasks, 4 concurrent by default) and chained agents with `{previous}` substitution work exactly as before; the only change is that the **whole** parallel/chain run is one background job, not each task individually.

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect docs" },
    { "agent": "scout", "task": "Inspect examples" }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Find relevant files for X" },
    { "agent": "planner", "task": "Plan X using this context: {previous}" }
  ]
}
```

List discovered agent *definitions* (unchanged):

```text
/subagents
```

### Mode selection

The mode is chosen from content, not from key presence, because some models emit every property of the schema and fill the unused ones with `""` or `[]`:

- Blank `agent`/`task` strings and empty `tasks`/`chain` arrays count as absent.
- A non-empty `chain` wins over `tasks`, and both win over leftover `agent`/`task` values.
- Task/chain entries blank on both fields are dropped; half-filled entries are reported by position.

### What still fails synchronously (before backgrounding)

- Invalid mode selection (neither single, tasks, nor chain; or both tasks and chain).
- Unknown agent name(s) anywhere in the request (single `agent`, any `tasks[].agent`, any `chain[].agent`).
- Recursion depth/allow checks (`PI_SUBAGENT_DEPTH` vs config).
- The project-agent confirmation prompt (`ctx.ui.confirm`), when applicable — this briefly blocks on a human decision, not on process work.

Everything else — spawning, streaming, retries, and the final result — happens in the background.

## Built-in agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `explore` | Read-only codebase exploration | zai/glm-5.1 | read, grep, find, ls |
| `webfetch` | Search, fetch, and synthesize public web resources | zai/glm-5.1 | websearch, webfetch |

Both agents are read-only. They cannot modify files, run bash commands, or edit anything. The `webfetch` agent uses `websearch` to discover URLs and `webfetch` to read selected pages.

## Custom agents

You can add more agents as Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What it does
tools: read, grep
model: glm-5.1
---
System prompt.
```

Locations:

- User: `~/.pi/agent/agents/*.md`
- Project: nearest `.pi/agents/*.md`

Project agents override user agents with the same `name`.

Tool defaults:

- Missing `tools` frontmatter → child uses normal Pi defaults.
- `tools: read, grep, find, ls` → `--tools read,grep,find,ls`.
- `tools: []` in agent frontmatter or config `defaultTools` → `--no-tools` (hand-written, so it is taken literally).
- `tools: []` in a **tool call** (top level, `tasks[].tools`, `chain[].tools`) → ignored, the child keeps its agent/config policy, and a warning diagnostic is attached. Models that emit every property send `[]` as filler, and a silently toolless child is the worse failure.
- `tools: ["none"]` in a tool call → `--no-tools`. This is the explicit way to ask for a toolless child from a call site; `"none"` wins if it is mixed with real tool names.

## Config

Preferred user config path:

```bash
~/.pi/agent/subagent.config.json
```

Nearest project override path:

```bash
.pi/subagent.config.json
```

Precedence: defaults < user config < project config < tool-call parameters.

Example with safer read-only defaults:

```json
{
  "agentScope": "both",
  "confirmProjectAgents": true,
  "defaultTools": ["read", "grep", "find", "ls"],
  "maxParallelTasks": 8,
  "maxConcurrency": 4,
  "emptyOutputRetries": 3
}
```

### Empty-output retries

`emptyOutputRetries` (default `3`, range `0`–`10`) controls how many **extra** times a
subagent is re-run when it finishes cleanly (exit 0, no error, not aborted) but returns
no assistant output — the `(no output)` case. Some providers/models intermittently emit
an empty completion (no tool calls, no text), e.g. GitHub Copilot–proxied GPT‑5 models
hitting a content filter or a reasoning-only stop. Because an empty run did no work,
the retry is cheap and usually succeeds. Failed or aborted runs are never retried (a
misconfig or crash would just waste attempts), and an abort between attempts stops the
loop. Set `emptyOutputRetries` to `0` to disable. Applies to single, parallel, and chain modes.

Runtime allowlist example:

```json
{
  "runtime": {
    "extensions": {
      "mode": "allowlist",
      "allow": ["~/.pi/agent/extensions/my-provider/index.ts"]
    },
    "skills": { "mode": "none" },
    "promptTemplates": { "mode": "none" },
    "contextFiles": "none"
  }
}
```

When extension allowlist mode is enabled, inherited extensions are disabled with `--no-extensions`, then each configured path is added with `--extension`. If a child model depends on a custom provider extension, add that provider extension path to `runtime.extensions.allow`.

## Recursion guard

Child processes receive `PI_SUBAGENT_DEPTH` incremented. The subagent tool is not registered at depth > 0 unless config explicitly allows recursion:

```json
{
  "recursion": { "allow": true, "maxDepth": 3 }
}
```

Leave recursion disabled unless you have a specific bounded workflow.

## Architecture

- `agent-store.ts` — the background job store (`AgentJobStore`). Tracks running/finished jobs, exposes `onChange`/`onExit` subscriptions, and owns cancellation via a per-job `AbortController`. Mirrors `bg-jobs/jobs.ts`'s shape deliberately.
- `orchestrate.ts` — the single/parallel/chain control flow, extracted from the tool so it can run as one job-store-tracked promise instead of blocking `execute()`. `runAgent` is injectable for tests.
- `runner.ts` — spawns the actual `pi` subprocess for one agent invocation and parses its `--mode json` event stream.
- `agent-format.ts` / `agent-picker.ts` / `agent-detail.ts` — the human-facing job list and detail overlay, built on `../shared/overlay.ts`.
- `render.ts` — tool-call/result rendering. `renderSubagentStarted` renders the tool's own immediate "started" stub; `renderSubagentResult` (unchanged) now renders the completion message instead of a live blocking tool result.

## Validation

```bash
cd ~/.pi/agent/extensions/subagent
npm test
npx tsc --noEmit
pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts --list-models
```

LLM smoke examples:

```bash
pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts -p \
  'Use the subagent tool with agent explore to find how extensions are loaded.'

pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts -p \
  'Use the subagent tool with agent webfetch to search for the current Node.js LTS version, fetch the official Node.js source, and summarize it.'

pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts -p \
  'Use the subagent tool in parallel: explore searches the codebase for auth code, webfetch searches for OAuth 2.0 guidance and fetches the most authoritative source.'
```

Automated tests never spawn a real `pi` subprocess (matching the pre-existing style of `runner-args.test.ts`): `agent-store.test.ts` and `orchestrate.test.ts` inject a fake `run`/`runAgent` function to exercise the background-job contract and mode control flow without process overhead.
