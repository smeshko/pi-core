/** Agent job picker overlay — the list view shown when 2+ jobs exist. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PickerRow, showSelectPicker } from "../shared/overlay.ts";
import { jobRuntime, jobStatusColor, jobStatusIcon, jobStatusLabel, lastActivityLine } from "./agent-format.ts";
import type { AgentJobRecord } from "./agent-store.ts";

function toRow(job: AgentJobRecord): PickerRow {
	return {
		value: job.jobId,
		label: job.name,
		description: `${jobStatusLabel(job)} · ${jobRuntime(job)} · ${lastActivityLine(job)}`,
		icon: jobStatusIcon(job),
		iconColor: jobStatusColor(job),
	};
}

/** Show the agent job list. Resolves with the chosen job id, or null if cancelled. */
export async function showAgentJobPicker(ctx: ExtensionContext, jobs: AgentJobRecord[]): Promise<string | null> {
	return showSelectPicker(ctx, "Subagents", jobs.map(toRow));
}
