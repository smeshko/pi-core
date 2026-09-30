import type { ConfigDiagnostic, SubagentParams, TaskParams } from "./types.ts";

export type SubagentMode = "single" | "parallel" | "chain";

/** Explicit opt-in for a child with no tools, since an empty array is usually model filler. */
export const NO_TOOLS_SENTINEL = "none";

export interface ModeDecision {
	mode?: SubagentMode;
	error?: string;
}

export interface NormalizedParams {
	params: SubagentParams;
	diagnostics: ConfigDiagnostic[];
	error?: string;
}

function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : undefined;
	return trimmed ? trimmed : undefined;
}

/**
 * Drops filler entries and reports entries that are only half filled.
 * Some models emit every property of the schema, so unused modes arrive as "" or [].
 */
function normalizeTaskList(
	list: TaskParams[] | undefined,
	field: "tasks" | "chain",
	diagnostics: ConfigDiagnostic[],
): { items: TaskParams[]; invalid: number[] } {
	const items: TaskParams[] = [];
	const invalid: number[] = [];
	const entries = Array.isArray(list) ? list : [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const agent = blankToUndefined(entry?.agent);
		const task = blankToUndefined(entry?.task);
		if (!agent && !task) continue;
		if (!agent || !task) {
			invalid.push(index + 1);
			continue;
		}
		items.push({ ...entry, agent, task, tools: normalizeToolsParam(entry.tools, `${field}[${index + 1}].tools`, diagnostics) });
	}
	return { items, invalid };
}

/**
 * An empty tools array means "not specified", because models that emit every property send [] as filler
 * and a child launched with --no-tools fails silently. `["none"]` is the explicit way to ask for no tools.
 */
function normalizeToolsParam(value: string[] | undefined, field: string, diagnostics: ConfigDiagnostic[]): string[] | undefined {
	if (value === undefined) return undefined;
	const items = (Array.isArray(value) ? value : [])
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
	if (items.length === 0) {
		diagnostics.push({
			level: "warning",
			message: `Ignored empty ${field}; the child keeps its own agent/config tool policy. Pass ["${NO_TOOLS_SENTINEL}"] to run a child with no tools.`,
		});
		return undefined;
	}
	const others = items.filter((item) => item.toLowerCase() !== NO_TOOLS_SENTINEL);
	if (others.length === items.length) return [...new Set(items)];
	if (others.length > 0) {
		diagnostics.push({
			level: "warning",
			message: `${field} listed "${NO_TOOLS_SENTINEL}" together with ${others.join(", ")}; "${NO_TOOLS_SENTINEL}" wins and the child runs with no tools.`,
		});
	}
	return [];
}

/** Rewrites blank strings and empty arrays to undefined so mode selection can look at content only. */
export function normalizeParams(params: SubagentParams): NormalizedParams {
	const diagnostics: ConfigDiagnostic[] = [];
	const tasks = normalizeTaskList(params.tasks, "tasks", diagnostics);
	const chain = normalizeTaskList(params.chain, "chain", diagnostics);
	const normalized: SubagentParams = {
		...params,
		agent: blankToUndefined(params.agent),
		task: blankToUndefined(params.task),
		cwd: blankToUndefined(params.cwd),
		tools: normalizeToolsParam(params.tools, "tools", diagnostics),
		tasks: tasks.items.length > 0 ? tasks.items : undefined,
		chain: chain.items.length > 0 ? chain.items : undefined,
	};
	if (tasks.invalid.length > 0) {
		return { params: normalized, diagnostics, error: `Each tasks entry needs both agent and task. Incomplete entries: ${tasks.invalid.join(", ")}.` };
	}
	if (chain.invalid.length > 0) {
		return { params: normalized, diagnostics, error: `Each chain entry needs both agent and task. Incomplete entries: ${chain.invalid.join(", ")}.` };
	}
	return { params: normalized, diagnostics };
}

/** Expects already normalized params: blank single fields and empty arrays must be undefined. */
export function determineMode(params: SubagentParams): ModeDecision {
	const hasSingle = Boolean(params.agent && params.task);
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasChain = (params.chain?.length ?? 0) > 0;

	if (hasTasks && hasChain) return { error: "Provide either tasks (parallel) or chain (sequential), not both." };
	// Arrays win over the single-mode fields, which are the ones models tend to fill with leftovers.
	if (hasChain) return { mode: "chain" };
	if (hasTasks) return { mode: "parallel" };
	if (hasSingle) return { mode: "single" };
	if (params.agent || params.task) return { error: "Single mode requires both agent and task." };
	return { error: "Provide exactly one mode: single (agent+task), parallel (tasks), or chain (chain)." };
}

export function resolveMode(params: SubagentParams): { params: SubagentParams; diagnostics: ConfigDiagnostic[]; decision: ModeDecision } {
	const normalized = normalizeParams(params);
	const decision = normalized.error ? { error: normalized.error } : determineMode(normalized.params);
	return { params: normalized.params, diagnostics: normalized.diagnostics, decision };
}
