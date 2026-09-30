/**
 * new-session-with-message
 *
 * Start a fresh session seeded with a single message.
 *
 *   /new-with <message>     - you invoke it
 *   new_session tool        - the model invokes it (e.g. at the end of a step)
 *
 * newSession() is only available to command handlers, so the tool records the
 * message and ends the run; once the agent has settled, the extension dispatches
 * its own command, which performs the switch.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "new-with";

export default function (pi: ExtensionAPI) {
	let pending: string | null = null;

	async function startWith(message: string, ctx: ExtensionCommandContext) {
		const parentSession = ctx.sessionManager.getSessionFile();
		const result = await ctx.newSession({
			parentSession,
			withSession: async (next) => {
				await next.sendUserMessage(message);
			},
		});
		if (result.cancelled && ctx.hasUI) ctx.ui.notify("New session cancelled", "info");
	}

	pi.registerCommand(COMMAND, {
		description: "Start a new session and send <message> as its first prompt",
		handler: async (args, ctx) => {
			const message = args.trim() || pending;
			pending = null;
			if (!message) {
				if (ctx.hasUI) ctx.ui.notify(`Usage: /${COMMAND} <message>`, "warning");
				return;
			}
			await startWith(message, ctx);
		},
	});

	pi.registerTool(
		defineTool({
			name: "new_session",
			label: "New session",
			description:
				"End the current session and start a fresh one whose first user message is `message`. " +
				"The new session has NO access to this conversation, so the message must be self-contained: " +
				"state the task and point to artifact files on disk. Persist anything important to files before calling. " +
				"Must be the last action of the turn.",
			parameters: Type.Object({
				message: Type.String({ description: "First prompt of the new session (short, self-contained)" }),
			}),
			async execute(_id, params) {
				pending = params.message;
				return {
					content: [{ type: "text", text: "New session will start once this run ends." }],
					details: { message: params.message },
					terminate: true,
				};
			},
		}),
	);

	pi.on("agent_settled", () => {
		if (pending) pi.sendUserMessage(`/${COMMAND}`, { expandPromptTemplates: true });
	});
}
