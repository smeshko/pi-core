import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { collectReport, preloadKeybindingDefaults, type ContextReport } from "./src/collect.ts";
import { renderReport } from "./src/render.ts";

const ENTRY_TYPE = "context-usage";

export default function contextExtension(pi: ExtensionAPI): void {
	// Custom entries render in the transcript and never enter the LLM context.
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const report = entry.data as ContextReport | undefined;
		const component = new Text("", 0, 0);

		return {
			render(width: number): string[] {
				if (!report) return [theme.fg("error", "No context report data")];
				try {
					component.setText(renderReport(report, theme, width).join("\n"));
				} catch (error) {
					// Never let a malformed/stale entry take down the TUI render loop.
					return [theme.fg("error", `Context report render failed: ${error instanceof Error ? error.message : String(error)}`)];
				}
				return component.render(width);
			},
			invalidate(): void {
				component.invalidate();
			},
		};
	});

	pi.registerCommand("context", {
		description: "Show context window usage by category plus loaded extensions, skills, and agents",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			await preloadKeybindingDefaults();
			try {
				pi.appendEntry(ENTRY_TYPE, collectReport(pi, ctx));
			} catch (error) {
				ctx.ui.notify(`/context failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
