/** Presentation helpers shared by the tools, picker, and detail view. */

import { isRunning, type JobRecord } from "./jobs.ts";

export type StatusKind = "running" | "killed" | "ok" | "failed";

export function statusKind(job: JobRecord): StatusKind {
	if (isRunning(job)) return "running";
	if (job.signal !== null || job.killRequested) return "killed";
	return job.exitCode === 0 ? "ok" : "failed";
}

export function statusIcon(job: JobRecord): string {
	switch (statusKind(job)) {
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

/** Theme colour name matching the job's status. */
export function statusColor(job: JobRecord): "warning" | "success" | "error" | "muted" {
	switch (statusKind(job)) {
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

export function statusLabel(job: JobRecord): string {
	switch (statusKind(job)) {
		case "running":
			return "running";
		case "ok":
			return "exited (0)";
		case "killed":
			return job.signal ? `killed (${job.signal})` : "killed";
		case "failed":
			return `exited (${job.exitCode ?? "unknown"})`;
	}
}

/** Compact duration: 8s, 2m 5s, 1h 3m. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/** Elapsed for a running job, total runtime for a finished one. */
export function jobRuntime(job: JobRecord): string {
	const end = job.finishedAt ?? Date.now();
	return formatDuration(end - job.startedAt);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Single-line gist of a job's most recent output, for the picker rows. */
export function lastOutputLine(job: JobRecord): string {
	for (let i = job.lines.length - 1; i >= 0; i -= 1) {
		const line = job.lines[i]?.trim();
		if (line) return line;
	}
	return "(no output yet)";
}

/** One-line summary used by bg_list and the job picker. */
export function summarize(job: JobRecord): string {
	return `${statusIcon(job)} ${job.name} · ${statusLabel(job)} · ${jobRuntime(job)}`;
}
