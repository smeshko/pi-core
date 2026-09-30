import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "system-prompt-output";

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (entry) => {
		const { prompt } = entry.data as { prompt: string };
		return new Text(prompt, 0, 0);
	});

	pi.registerCommand("system-prompt", {
		description: "Print the complete active system prompt",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();

			if (ctx.mode === "tui") {
				pi.appendEntry(ENTRY_TYPE, { prompt });
				return;
			}

			console.log(prompt);
		},
	});
}
