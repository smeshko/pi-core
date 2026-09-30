# Global Pi Guidance

- Delegate any medium-or-larger codebase exploration to the `explore` subagent first.
- Prefer `explore` whenever the task needs multiple files, cross-file references, symbol tracing, or structure discovery.
- Use direct `read`/`grep`/`find`/`ls` only for trivial single-file lookups or quick confirmation.
- Use `webfetch` for public web research and current external documentation.
- When in doubt, default to `explore`.

## Two separate background systems

`bg_run` starts a **shell job** (ids like `job-1`). `bg_status` / `bg_list` / `bg_kill` track **only** shell jobs.
`subagent` starts an **agent job** (ids like `agent-1`). Its result arrives as a message; `bg_status` / `bg_list` cannot see it.

After any background call — `bg_run` or `subagent` — end your turn. Pi delivers the outcome automatically.
