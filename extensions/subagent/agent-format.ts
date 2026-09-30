/** Presentation helpers for agent job records, mirroring bg-jobs/format.ts. */

import { getDisplayItems, getFinalOutput } from "./json-events.ts";
import { isJobRunning, type AgentJobRecord } from "./agent-store.ts";
import { isFailedResult } from "./runner.ts";

export type JobStatusKind = "running" | "killed" | "ok" | "failed";

export function jobStatusKind(job: AgentJobRecord): JobStatusKind {
	if (isJobRunning(job)) return "running";
	if (job.killRequested) return "killed";
	return job.ok ? "ok" : "failed";
}

export function jobStatusIcon(job: AgentJobRecord): string {
	switch (jobStatusKind(job)) {
		case "running":
			return "●";
		case "ok":
			return "✓";
		case "killed":
			return "■";
		case "failed":
			return "✗";
	}
}

export function jobStatusColor(job: AgentJobRecord): "warning" | "success" | "error" | "muted" {
	switch (jobStatusKind(job)) {
		case "running":
			return "warning";
		case "ok":
			return "success";
		case "killed":
			return "muted";
		case "failed":
			return "error";
	}
}

export function jobStatusLabel(job: AgentJobRecord): string {
	switch (jobStatusKind(job)) {
		case "running":
			return "running";
		case "ok":
			return "completed";
		case "killed":
			return "cancelled";
		case "failed":
			return "failed";
	}
}

/** Compact duration: 8s, 2m 5s, 1h 3m. Mirrors bg-jobs/format.ts's formatDuration. */
export function formatJobDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function jobRuntime(job: AgentJobRecord): string {
	const end = job.finishedAt ?? Date.now();
	return formatJobDuration(end - job.startedAt);
}

/** Single-line gist of a job's most recent activity, for the picker rows. */
export function lastActivityLine(job: AgentJobRecord): string {
	const results = job.details.results;
	if (results.length === 0) return "(starting…)";

	if (job.mode === "single") {
		const result = results[0]!;
		const items = getDisplayItems(result.messages, result.activity);
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			if (item.type === "toolCall") return `${item.name} ${JSON.stringify(item.args).slice(0, 60)}`;
			if (item.type === "text") return item.text.split("\n")[0]?.slice(0, 80) ?? "";
		}
		return getFinalOutput(result.messages).split("\n")[0]?.slice(0, 80) || "(no output yet)";
	}

	const running = results.filter((result) => result.exitCode === -1).length;
	const done = results.length - running;
	return `${done}/${results.length} done${running > 0 ? `, ${running} running` : ""}`;
}

/** Total tool calls made so far, across every agent in the job. */
export function totalToolCalls(job: AgentJobRecord): number {
	return job.details.results.reduce(
		(sum, result) => sum + getDisplayItems(result.messages, result.activity).filter((item) => item.type === "toolCall").length,
		0,
	);
}

export function summarizeJobForWidget(job: AgentJobRecord): string {
	return `${job.name} ${jobRuntime(job)}`;
}

export { isFailedResult };
