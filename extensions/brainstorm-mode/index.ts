/**
 * Brainstorm Mode
 *
 * A read-only, divergent-thinking mode toggled with Tab on an empty prompt.
 *
 *   ─── BRAINSTORM ─────────────────────────────────────────
 *    > your input
 *   ─────────────────────────────────────────────────────────
 *
 * Enforcement is layered, because prose alone is not read-only:
 *
 *   1. `setActiveTools()` narrows the schema to an allowlist, so write tools are
 *      not merely discouraged - they are absent.
 *   2. The `tool_call` hook re-checks every call, catching tools that appear
 *      after mode entry (the MCP loader adds tools to the active set mid-turn).
 *   3. `subagent` arguments are coerced, since its `tools` parameter overrides
 *      the child agent's frontmatter and would otherwise grant write access.
 *   4. The system prompt shapes behaviour. It does not enforce it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardToolCall, isToolNameAllowed, parseMcpToolName } from "./guards.ts";
import { BrainstormEditor } from "./editor.ts";
import { BRAINSTORM_MODE, modeById, nextMode, NORMAL_MODE, type Mode } from "./modes.ts";
import { registerBrainstormSaveTool } from "./save-tool.ts";

/**
 * Read-only MCP tools the verb heuristic in guards.ts misclassifies.
 * Add remote tool names (without the `mcp__<server>__` prefix) here.
 */
const EXTRA_ALLOWED_MCP_TOOLS = new Set<string>([]);

const STATE_ENTRY = "brainstorm-mode";

interface ArtifactFile {
	absPath: string;
	relPath: string;
}

interface PersistedState {
	modeId: string;
	toolsBeforeMode?: string[];
	artifact?: ArtifactFile;
}

export default function brainstormMode(pi: ExtensionAPI): void {
	let mode: Mode = NORMAL_MODE;
	/** Active tools captured on entry, so exit restores exactly rather than guessing. */
	let toolsBeforeMode: string[] | undefined;
	/** The running document for this brainstorm segment, once the agent has started one. */
	let artifact: ArtifactFile | undefined;
	/** Set when a cycle is requested mid-run; applied once the agent settles. */
	let pendingCycle = false;
	/** Set when a final capture turn is running on the way out. */
	let exitAfterTurn = false;
	/** Repaint trigger handed over by the editor instance. */
	let requestRender: () => void = () => {};
	/** Notification deferred until the exit capture turn finishes. */
	let notifyOnExit: ((ctx: ExtensionContext) => void) | undefined;
	/**
	 * True once the agent has started at least one turn in the current brainstorm
	 * segment. Guards against triggering an exit-save turn when the user enters
	 * and immediately leaves brainstorm mode without ever sending a message.
	 */
	let hadInteractionInBrainstorm = false;
	/** True while the 3-second entry grace period is counting down. */
	let gracePeriodActive = false;
	let gracePeriodSecondsLeft = 0;
	let gracePeriodTimer: ReturnType<typeof setTimeout> | undefined;
	let gracePeriodCountdown: ReturnType<typeof setInterval> | undefined;
	/** Context that owns the active grace-period status row, so we can clear it. */
	let gracePeriodCtx: ExtensionContext | undefined;

	// ---- Grace period helpers ---------------------------------------------

	/**
	 * Stop any running grace-period timer and clear the footer status.
	 * Safe to call even when no grace period is active.
	 */
	function clearGracePeriod(): void {
		if (gracePeriodTimer !== undefined) {
			clearTimeout(gracePeriodTimer);
			gracePeriodTimer = undefined;
		}
		if (gracePeriodCountdown !== undefined) {
			clearInterval(gracePeriodCountdown);
			gracePeriodCountdown = undefined;
		}
		if (gracePeriodActive) {
			gracePeriodActive = false;
			gracePeriodCtx?.ui.setStatus("brainstorm-grace", "");
		}
		gracePeriodCtx = undefined;
	}

	/**
	 * Enter the 3-second window in which Esc reverts the mode switch.
	 * The editor headline shows the hint; the footer shows a status row.
	 */
	function startGracePeriod(ctx: ExtensionContext): void {
		clearGracePeriod(); // defensive: should always be a no-op
		gracePeriodCtx = ctx;
		gracePeriodActive = true;
		gracePeriodSecondsLeft = 3;
		const updateStatus = (s: number) =>
			ctx.ui.setStatus("brainstorm-grace", `Brainstorm mode  ─  Esc to cancel (${s})`)
		updateStatus(gracePeriodSecondsLeft);
		requestRender();
		gracePeriodCountdown = setInterval(() => {
			gracePeriodSecondsLeft--;
			if (gracePeriodSecondsLeft > 0) updateStatus(gracePeriodSecondsLeft);
		}, 1000);
		gracePeriodTimer = setTimeout(() => {
			clearGracePeriod();
			requestRender();
		}, 3000);
	}

	registerBrainstormSaveTool(pi, {
		getPinnedFile: () => artifact,
		onSaved: (file) => {
			artifact = file;
			persist();
		},
	});

	function persist(): void {
		pi.appendEntry(STATE_ENTRY, { modeId: mode.id, toolsBeforeMode, artifact } satisfies PersistedState);
	}

	function isAllowed(toolName: string): boolean {
		if (!mode.allowedTools) return true;
		return isToolNameAllowed(toolName, EXTRA_ALLOWED_MCP_TOOLS);
	}

	/** Narrow the active set. Never widens: the allowlist is intersected with what was already on. */
	function applyToolPolicy(): void {
		if (!mode.allowedTools) {
			// Restore, keeping anything legitimately added while the mode was active
			// (e.g. MCP tools loaded during the session).
			const restored = new Set([...(toolsBeforeMode ?? pi.getActiveTools()), ...pi.getActiveTools()]);
			restored.delete("brainstorm_save");
			pi.setActiveTools([...restored]);
			toolsBeforeMode = undefined;
			return;
		}

		toolsBeforeMode ??= pi.getActiveTools();
		const candidates = new Set([...toolsBeforeMode, "brainstorm_save"]);
		pi.setActiveTools([...candidates].filter((name) => isAllowed(name)));
	}

	function setMode(next: Mode): void {
		mode = next;
		if (next.id === BRAINSTORM_MODE.id) {
			artifact = undefined;
			hadInteractionInBrainstorm = false;
		} else {
			// Leaving brainstorm for any reason — stop any outstanding grace timer.
			clearGracePeriod();
		}
		applyToolPolicy();
		persist();
		requestRender();
	}

	/**
	 * Tab (and `/brainstorm` command) handler.
	 *
	 * Entry: applies the mode immediately, then opens a 3-second grace period so
	 * an accidental Tab can be undone with Esc before any turn is triggered.
	 *
	 * Exit: if the user never sent a message in this brainstorm segment, there is
	 * nothing to capture, so we skip the exit-save turn and leave silently.
	 * Only when at least one turn has run do we fire the save turn.
	 */
	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.isIdle()) {
			pendingCycle = true;
			ctx.ui.notify("Mode switch queued until the current turn finishes.", "info");
			return;
		}

		const target = nextMode(mode);
		const leavingBrainstorm = mode.savesArtifact === true && target.id === NORMAL_MODE.id;

		// Grace period on entry: switch mode immediately so the border changes,
		// but give the user 3 s to press Esc and revert.
		if (target.id === BRAINSTORM_MODE.id) {
			setMode(target);
			startGracePeriod(ctx);
			return;
		}

		if (leavingBrainstorm && !artifact) {
			// No interaction in this segment → nothing to save; exit silently.
			if (!hadInteractionInBrainstorm) {
				setMode(target);
				ctx.ui.notify("Left brainstorm mode. Nothing to save.", "info");
				return;
			}
			exitAfterTurn = true;
			notifyOnExit = (exitCtx) => announce(exitCtx);
			pi.sendMessage(
				{
					customType: "brainstorm-exit-save",
					content:
						"Leaving brainstorm mode and no brainstorm document exists yet. Call " +
						"`brainstorm_save` now with the complete document for this session. Do not ask " +
						"any further questions and do not reply with prose - just save.",
					display: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		setMode(target);
		if (leavingBrainstorm) announce(ctx);
	}

	/** Confirm where the running document ended up. */
	function announce(ctx: ExtensionContext): void {
		if (artifact) ctx.ui.notify(`Brainstorm saved to ${artifact.relPath}`, "info");
		else ctx.ui.notify("Left brainstorm mode. Nothing was captured.", "warning");
	}

	function installEditor(ctx: ExtensionContext): void {
		const appTheme = ctx.ui.theme;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new BrainstormEditor(tui, theme, keybindings, {
					appTheme,
					getMode: () => mode,
					onCycle: () => {
						void cycleMode(ctx);
					},
					isGracePeriodActive: () => gracePeriodActive,
					onGraceCancel: () => {
						// clearGracePeriod() is called inside setMode when leaving brainstorm.
						setMode(NORMAL_MODE);
						ctx.ui.notify("Brainstorm mode cancelled.", "info");
					},
					registerRenderer: (render) => {
						requestRender = render;
					},
				}),
		);
	}

	// --- Enforcement ---------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (!mode.allowedTools) return;
		const verdict = guardToolCall(event.toolName, event.input as Record<string, unknown>, {
			extraAllow: EXTRA_ALLOWED_MCP_TOOLS,
		});
		if (verdict.reason) return { block: true, reason: verdict.reason };
	});

	// The MCP loader calls setActiveTools() additively when it loads tools, which
	// would slip mutating tools back into the schema. Re-narrow afterwards.
	pi.on("tool_result", async (event) => {
		if (!mode.allowedTools || event.toolName !== "search_mcp_tools") return;
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !parseMcpToolName(name) || isAllowed(name));
		if (filtered.length !== active.length) pi.setActiveTools(filtered);
	});

	pi.on("before_agent_start", async (event) => {
		if (mode.id === BRAINSTORM_MODE.id) hadInteractionInBrainstorm = true;
		if (!mode.systemPrompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${mode.systemPrompt}` };
	});

	// `/brainstorm` command — also used by tests to trigger cycleMode directly.
	pi.registerCommand("brainstorm", {
		description: "Toggle brainstorm mode",
		handler: async (_args, ctx) => {
			await cycleMode(ctx as ExtensionContext);
		},
	});

	// --- Lifecycle -----------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		if (exitAfterTurn) {
			exitAfterTurn = false;
			pendingCycle = false;
			const notify = notifyOnExit;
			notifyOnExit = undefined;
			// setMode only resets the artifact when *entering* brainstorm, so the path
			// captured by the exit turn is still available to announce here.
			setMode(NORMAL_MODE);
			notify?.(ctx);
			return;
		}
		if (pendingCycle) {
			pendingCycle = false;
			await cycleMode(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const saved = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_ENTRY)
			.pop() as { data?: PersistedState } | undefined;

		if (saved?.data) {
			mode = modeById(saved.data.modeId);
			toolsBeforeMode = saved.data.toolsBeforeMode;
			artifact = saved.data.artifact;
		}

		if (ctx.hasUI) installEditor(ctx);
		if (mode.allowedTools) applyToolPolicy();
	});
}
