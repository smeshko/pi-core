/** Job picker overlay — the list view shown when 2+ jobs exist. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PickerRow, showSelectPicker } from "../shared/overlay.ts";
import { jobRuntime, lastOutputLine, statusColor, statusIcon, statusLabel } from "./format.ts";
import type { BackgroundJobStore, JobRecord } from "./jobs.ts";

function toRow(job: JobRecord): PickerRow {
	return {
		value: job.jobId,
		label: job.name,
		description: `${statusLabel(job)} · ${jobRuntime(job)} · ${lastOutputLine(job)}`,
		icon: statusIcon(job),
		iconColor: statusColor(job),
	};
}

/** Show the job list. Resolves with the chosen job id, or null if cancelled. */
export async function showJobPicker(ctx: ExtensionContext, store: BackgroundJobStore): Promise<string | null> {
	return showSelectPicker(ctx, "Background Jobs", store.list().map(toRow));
}
