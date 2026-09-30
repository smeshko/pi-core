/**
 * Mode registry.
 *
 * Deliberately a list rather than a boolean: Tab cycles `(index + 1) % MODES.length`,
 * so adding a third mode later (a converging "plan" mode, say) is one entry here
 * plus its tool policy - no control-flow surgery anywhere else.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { ALLOWED_TOOLS } from "./guards.ts";
import { BRAINSTORM_SYSTEM_PROMPT } from "./prompt.ts";

export interface Mode {
	id: string;
	/** Shown in the editor's top border. */
	label: string;
	/** Theme color for the editor border while this mode is active. */
	color: Parameters<Theme["fg"]>[0];
	/** Undefined means unrestricted. */
	allowedTools?: readonly string[];
	/** Appended to the chained system prompt while this mode is active. */
	systemPrompt?: string;
	/** Whether leaving this mode should offer to save an artifact. */
	savesArtifact?: boolean;
}

export const NORMAL_MODE: Mode = {
	id: "normal",
	label: "NORMAL",
	color: "border",
};

export const BRAINSTORM_MODE: Mode = {
	id: "brainstorm",
	label: "BRAINSTORM",
	// Violet. Theme-aware, and unmistakably not the blue of normal mode.
	color: "customMessageLabel",
	allowedTools: ALLOWED_TOOLS,
	systemPrompt: BRAINSTORM_SYSTEM_PROMPT,
	savesArtifact: true,
};

export const MODES: Mode[] = [NORMAL_MODE, BRAINSTORM_MODE];

export function nextMode(current: Mode): Mode {
	const index = MODES.findIndex((mode) => mode.id === current.id);
	return MODES[(index + 1) % MODES.length]!;
}

export function modeById(id: string | undefined): Mode {
	return MODES.find((mode) => mode.id === id) ?? NORMAL_MODE;
}
