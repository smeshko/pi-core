/**
 * Background Bash Execution
 *
 * Runs shell commands in the background so the conversation keeps flowing, and
 * gives the human an interactive overlay (ctrl+alt+b or /bg) to inspect and
 * kill them.
 *
 * Design rule: these tools NEVER block the agent turn. bg_run returns
 * immediately; when a job finishes, the human gets a toast and the agent gets a
 * queued message it picks up on its next turn. Work that genuinely needs to
 * block belongs in the built-in bash tool.
 *
 * Jobs are session-scoped: killed and their logs deleted on session_shutdown.
 * Temp dirs left by a crashed pi are reclaimed by the startup sweep.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	callHeader,
	clippedLines,
	plural,
	type RenderContext,
	textComponent,
	treeLines,
} from "../shared/tool-render-style.ts";
import { openListDetailOverlay } from "../shared/overlay.ts";
import { showJobDetail } from "./detail.ts";
import { formatBytes, jobRuntime, statusKind, statusLabel, summarize } from "./format.ts";
import { BackgroundJobStore, isRunning, type JobRecord, TAIL_LINES } from "./jobs.ts";
import { showJobPicker } from "./picker.ts";

const WIDGET_ID = "bg-jobs";
const SHORTCUT_LABEL = "ctrl+alt+b";
const WIDGET_TICK_MS = 1000;
const MAX_WIDGET_JOBS = 3;

/** Structured payload backing the house-style renderer for completion messages. */
interface BgJobFinishedDetails {
	jobId: string;
	name: string;
	status: string;
	runtime: string;
	ok: boolean;
	totalLines: number;
	bytes: number;
	tail: string[];
}

const BG_JOB_FINISHED = "bg-job-finished";
/** Lines of tail included in the completion message handed to the agent. */
const COMPLETION_TAIL_LINES = 20;
/** Long lines (absolute paths, stack traces) are clipped in that message. */
const COMPLETION_LINE_WIDTH = 160;

export default function backgroundJobsExtension(pi: ExtensionAPI): void {
	const store = new BackgroundJobStore(process.cwd());
	let uiCtx: ExtensionContext | null = null;
	let ticker: NodeJS.Timeout | null = null;
	let unsubscribeExit: (() => void) | null = null;
	/** Suppresses completion plumbing while dispose() kills jobs at shutdown. */
	let shuttingDown = false;

	// ---------------------------------------------------------------- widget

	function updateWidget(): void {
		if (!uiCtx?.hasUI) return;
		const running = store.running();
		if (running.length === 0) {
			uiCtx.ui.setStatus(WIDGET_ID, undefined);
			return;
		}

		const theme = uiCtx.ui.theme;
		const label = running.length === 1 ? "1 background job running" : `${running.length} background jobs running`;
		const shown = running.slice(0, MAX_WIDGET_JOBS).map((job) => `${job.name} ${jobRuntime(job)}`);
		const overflow = running.length > MAX_WIDGET_JOBS ? ` +${running.length - MAX_WIDGET_JOBS}` : "";

		uiCtx.ui.setStatus(
			WIDGET_ID,
			`${theme.fg("warning", "●")} ${theme.fg("muted", `${label} (${shown.join(", ")}${overflow})`)}  ${theme.fg("dim", SHORTCUT_LABEL)}`,
		);
	}

	function stopTicker(): void {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = null;
	}

	/** Ticks only while something runs; widget updates are not driven per output chunk. */
	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => {
			updateWidget();
			if (store.running().length === 0) stopTicker();
		}, WIDGET_TICK_MS);
	}

	// ------------------------------------------------------------ completion

	/**
	 * A job finished. Put the outcome into the agent's context and immediately
	 * start a turn so the agent can act on it. With no deliverAs, pi starts now
	 * when idle and steers the current run when already streaming.
	 */
	function handleJobExit(job: JobRecord): void {
		if (shuttingDown) return;

		const outcome = `${job.jobId} (${job.name}) ${statusLabel(job)} after ${jobRuntime(job)}`;
		const ok = statusKind(job) === "ok";

		// Do not call ui.notify here. In TUI mode it appends a grey status line
		// to the transcript, duplicating the house-style custom message below.
		// The rendered completion message is the user-facing notification.
		const tail = store
			.tail(job, COMPLETION_TAIL_LINES * 2)
			.filter((line) => line.trim().length > 0)
			.slice(-COMPLETION_TAIL_LINES)
			.map((line) => (line.length > COMPLETION_LINE_WIDTH ? `${line.slice(0, COMPLETION_LINE_WIDTH)}…` : line));
		try {
			pi.sendMessage<BgJobFinishedDetails>(
				{
					customType: BG_JOB_FINISHED,
					content:
						`Background job ${outcome}.\nCommand: ${job.command}\n\n` +
						`Last ${tail.length} output lines:\n${tail.join("\n") || "(no output)"}`,
					display: true,
					details: {
						jobId: job.jobId,
						name: job.name,
						status: statusLabel(job),
						runtime: jobRuntime(job),
						ok,
						totalLines: job.totalLines,
						bytes: job.bytes,
						tail,
					},
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			// Never swallow this silently: a lost completion message is invisible
			// to the user and looks like the job simply never finished.
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`Could not deliver completion for ${job.jobId}: ${reason}`);
		}

		updateWidget();
	}

	// --------------------------------------------------------------- overlay

	async function openOverlay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Background job UI requires the interactive TUI", "warning");
			return;
		}

		// Decision 16: a keypress with no jobs is a silent no-op.
		// Decision 15: a lone job skips the list, so there is nowhere to go back to.
		await openListDetailOverlay(
			ctx,
			{ list: () => store.list(), get: (id) => store.get(id), getId: (job) => job.jobId },
			(pickerCtx) => showJobPicker(pickerCtx, store),
			(detailCtx, job, canGoBack) => showJobDetail(detailCtx, store, job, canGoBack),
		);
	}

	// ---------------------------------------------------------------- tools

	/**
	 * Completion messages are visible in the transcript, so they follow the same
	 * house style as tool rows instead of pi's default custom-message block.
	 */
	pi.registerMessageRenderer<BgJobFinishedDetails>(BG_JOB_FINISHED, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;

		const header = [
			theme.fg(details.ok ? "success" : "error", "●"),
			" ",
			theme.fg("toolTitle", theme.bold("BackgroundTask")),
			theme.fg("muted", "("),
			theme.fg("accent", details.name),
			theme.fg("muted", ")"),
		].join("");

		const summary = [details.status, details.runtime, plural(details.totalLines, "line"), formatBytes(details.bytes)]
			.filter(Boolean)
			.join(theme.fg("muted", " · "));
		const hint = options.expanded ? "" : ` (${keyHint("app.tools.expand", "to expand")})`;
		const body = options.expanded
			? clippedLines(
					details.tail.map((line) => theme.fg("toolOutput", line)),
					COMPLETION_TAIL_LINES,
					theme,
					false,
				)
			: [];

		const rendered = [header, treeLines(theme, `${summary}${hint}`, body, { error: !details.ok })].join("\n");
		return new Text(rendered, options.outputPad ?? 0, 0);
	});

	function requireJob(idOrName: string): JobRecord {
		const job = store.get(idOrName);
		if (!job) {
			const known = store.list().map((candidate) => `${candidate.jobId} (${candidate.name})`);
			const hint = known.length > 0 ? ` Known jobs: ${known.join(", ")}` : " No jobs have been started.";
			throw new Error(`No background job matching "${idOrName}".${hint}`);
		}
		return job;
	}

	function describe(job: JobRecord): Record<string, unknown> {
		return {
			job_id: job.jobId,
			name: job.name,
			command: job.command,
			cwd: job.cwd,
			pid: job.pid,
			running: isRunning(job),
			exit_code: job.exitCode,
			signal: job.signal,
			status: statusLabel(job),
			runtime: jobRuntime(job),
			total_lines: job.totalLines,
			bytes: job.bytes,
			started_at: new Date(job.startedAt).toISOString(),
			finished_at: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
			log_file: job.logFile,
		};
	}

	function tailBlock(job: JobRecord): string {
		const tail = store.tail(job);
		return tail.length === 0 ? "(no output)" : tail.join("\n");
	}

	/** `└─ summary (ctrl+o to expand)` with optional expanded body. */
	function renderTree(
		theme: Parameters<typeof treeLines>[0],
		context: RenderContext,
		summary: string,
		body: string[],
		options?: { error?: boolean },
	) {
		const expandable = body.length > 0 && !context.expanded;
		const line = expandable ? `${summary} (${keyHint("app.tools.expand", "to expand")})` : summary;
		return textComponent(context, treeLines(theme, line, context.expanded ? body : [], options));
	}

	pi.registerTool({
		name: "bg_run",
		label: "Background Task",
		description:
			"Start a shell command in the background and return immediately with a job id. " +
			"Use for long-running work (builds, test suites, servers, watchers) so the conversation is not blocked. " +
			"Does not wait for the command: when it finishes you receive a message with the outcome. " +
			"After calling this, end your turn and stay responsive to the user.",
		promptSnippet: "Start a long-running shell command in the background without blocking the conversation",
		promptGuidelines: [
			"Use bg_run instead of bash for commands that take a long time or never exit, so the user can keep talking while they run.",
			"After bg_run, end the turn instead of polling bg_status in a loop; pi delivers the job's outcome automatically when it finishes.",
			"Use the built-in bash tool, not bg_run, when the result is needed immediately to continue the current turn.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run in the background" }),
			name: Type.Optional(Type.String({ description: "Short label for the job, e.g. 'tests'" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
		}),
		async execute(_toolCallId, params) {
			const job = store.run({ command: params.command, name: params.name, cwd: params.cwd });
			startTicker();
			updateWidget();

			return {
				content: [
					{
						type: "text",
						text:
							`Started ${job.jobId} (${job.name}) as pid ${job.pid}.\n` +
							`Log: ${job.logFile}\n\n` +
							"Running in the background — you will be told when it finishes. Do not wait on it.",
					},
				],
				details: describe(job),
			};
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const ctx = context as unknown as RenderContext;
			return textComponent(ctx, callHeader(theme, ctx, "BackgroundTask", String(args.command ?? ""), "command"));
		},
		renderResult(result, _options, theme, context) {
			const ctx = context as unknown as RenderContext;
			const details = result.details as Record<string, unknown> | undefined;
			if (ctx.isError) {
				return renderTree(theme, ctx, "Failed to start", [], { error: true });
			}
			const summary = `${details?.job_id} (${details?.name}) started · pid ${details?.pid}`;
			return renderTree(theme, ctx, summary, [String(details?.command ?? "")]);
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Status",
		description:
			`Get the current state and last ${TAIL_LINES} output lines of a background job. ` +
			"Returns immediately with whatever has been produced so far.",
		promptSnippet: "Check a background job's state and recent output",
		parameters: Type.Object({
			job: Type.String({ description: "Job id (e.g. 'job-1') or name" }),
		}),
		async execute(_toolCallId, params) {
			const job = requireJob(params.job);
			const header =
				`${job.jobId} (${job.name}) — ${statusLabel(job)}\n` +
				`Command: ${job.command}\n` +
				`Runtime: ${jobRuntime(job)} · ${job.totalLines} lines · ${formatBytes(job.bytes)}`;

			return {
				content: [{ type: "text", text: `${header}\n\n--- last output ---\n${tailBlock(job)}` }],
				details: { ...describe(job), last_lines: store.tail(job) },
			};
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const ctx = context as unknown as RenderContext;
			return textComponent(ctx, callHeader(theme, ctx, "BackgroundStatus", String(args.job ?? "")));
		},
		renderResult(result, _options, theme, context) {
			const ctx = context as unknown as RenderContext;
			const details = result.details as Record<string, unknown> | undefined;
			if (ctx.isError) {
				return renderTree(theme, ctx, "Unknown job", [], { error: true });
			}

			const lines = Number(details?.total_lines ?? 0);
			const summary = [
				String(details?.status ?? "unknown"),
				String(details?.runtime ?? ""),
				plural(lines, "line"),
				formatBytes(Number(details?.bytes ?? 0)),
			]
				.filter(Boolean)
				.join(theme.fg("muted", " · "));

			const tail = Array.isArray(details?.last_lines) ? (details.last_lines as string[]) : [];
			const body = clippedLines(
				tail.map((line) => theme.fg("toolOutput", line)),
				20,
				theme,
				true,
			);
			return renderTree(theme, ctx, summary, body, { error: details?.running === false && details?.exit_code !== 0 });
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "Background List",
		description: "List all background jobs started in this session, running and finished.",
		promptSnippet: "List all background jobs in this session",
		parameters: Type.Object({}),
		async execute() {
			const jobs = store.list();
			if (jobs.length === 0) {
				return { content: [{ type: "text", text: "No background jobs in this session." }], details: { jobs: [] } };
			}
			return {
				content: [{ type: "text", text: jobs.map(summarize).join("\n") }],
				details: { jobs: jobs.map(describe) },
			};
		},
		renderShell: "self",
		renderCall(_args, theme, context) {
			const ctx = context as unknown as RenderContext;
			return textComponent(ctx, callHeader(theme, ctx, "BackgroundList"));
		},
		renderResult(result, _options, theme, context) {
			const ctx = context as unknown as RenderContext;
			const details = result.details as { jobs?: Record<string, unknown>[] } | undefined;
			const jobs = details?.jobs ?? [];
			if (jobs.length === 0) return renderTree(theme, ctx, "No background jobs", []);

			const active = jobs.filter((job) => job.running === true).length;
			const summary = `${plural(jobs.length, "job")}${active > 0 ? `, ${active} running` : ""}`;
			const body = jobs.map((job) => theme.fg("toolOutput", `${job.job_id} (${job.name}) · ${job.status}`));
			return renderTree(theme, ctx, summary, body);
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Kill",
		description: "Terminate a background job (SIGTERM, then SIGKILL after a grace period).",
		promptSnippet: "Terminate a running background job",
		parameters: Type.Object({
			job: Type.String({ description: "Job id (e.g. 'job-1') or name" }),
		}),
		async execute(_toolCallId, params) {
			const job = requireJob(params.job);
			const result = await store.kill(job.jobId);
			updateWidget();
			return {
				content: [{ type: "text", text: result.message }],
				details: { ok: result.ok, message: result.message, ...describe(job) },
			};
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const ctx = context as unknown as RenderContext;
			return textComponent(ctx, callHeader(theme, ctx, "BackgroundKill", String(args.job ?? "")));
		},
		renderResult(result, _options, theme, context) {
			const ctx = context as unknown as RenderContext;
			const details = result.details as Record<string, unknown> | undefined;
			const ok = details?.ok === true;
			return renderTree(theme, ctx, String(details?.message ?? "Kill requested"), [], { error: !ok });
		},
	});

	// -------------------------------------------------- command and shortcut

	pi.registerCommand("bg", {
		description: "Inspect background jobs (/bg, or /bg kill <id>)",
		handler: async (args, ctx) => {
			const trimmed = args?.trim() ?? "";
			if (trimmed === "") {
				await openOverlay(ctx);
				return;
			}

			const [subcommand, ...rest] = trimmed.split(/\s+/);
			if (subcommand !== "kill") {
				ctx.ui.notify(`Unknown /bg subcommand "${subcommand}". Usage: /bg or /bg kill <id-or-name>`, "error");
				return;
			}

			const target = rest.join(" ").trim();
			if (!target) {
				ctx.ui.notify("Usage: /bg kill <id-or-name>", "error");
				return;
			}

			const job = store.get(target);
			if (!job) {
				ctx.ui.notify(`No background job matching "${target}"`, "error");
				return;
			}

			const result = await store.kill(job.jobId);
			updateWidget();
			ctx.ui.notify(result.message, result.ok ? "info" : "warning");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Show background jobs",
		handler: async (ctx) => {
			await openOverlay(ctx);
		},
	});

	// --------------------------------------------------------------- session

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		shuttingDown = false;
		store.init(ctx.sessionManager.getSessionId(), ctx.cwd);
		unsubscribeExit?.();
		unsubscribeExit = store.onExit(handleJobExit);
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		stopTicker();
		unsubscribeExit?.();
		unsubscribeExit = null;
		if (uiCtx?.hasUI) uiCtx.ui.setStatus(WIDGET_ID, undefined);
		await store.dispose();
		uiCtx = null;
	});
}
