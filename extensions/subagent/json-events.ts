import type { DisplayItem, PiMessage, SingleResult, UsageStats } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asMessage(value: unknown): PiMessage | undefined {
	const record = asRecord(value);
	if (!record || typeof record.role !== "string" || !Array.isArray(record.content)) return undefined;
	return record as unknown as PiMessage;
}

function appendUsage(usage: UsageStats, message: PiMessage): void {
	if (message.role !== "assistant") return;
	usage.turns += 1;
	const msgUsage = message.usage;
	if (!msgUsage) return;
	usage.input += typeof msgUsage.input === "number" ? msgUsage.input : 0;
	usage.output += typeof msgUsage.output === "number" ? msgUsage.output : 0;
	usage.cacheRead += typeof msgUsage.cacheRead === "number" ? msgUsage.cacheRead : 0;
	usage.cacheWrite += typeof msgUsage.cacheWrite === "number" ? msgUsage.cacheWrite : 0;
	if (typeof msgUsage.cost === "number") usage.cost += msgUsage.cost;
	else if (msgUsage.cost && typeof msgUsage.cost.total === "number") usage.cost += msgUsage.cost.total;
	const contextTokens = typeof msgUsage.contextTokens === "number" ? msgUsage.contextTokens : msgUsage.totalTokens;
	if (typeof contextTokens === "number") usage.contextTokens = Math.max(usage.contextTokens, contextTokens);
}

function messageDisplayItems(message: PiMessage): DisplayItem[] {
	const items: DisplayItem[] = [];
	if (message.role !== "assistant") return items;
	for (const part of message.content) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			items.push({ type: "text", text: part.text });
		} else if (part.type === "toolCall" && typeof part.name === "string") {
			items.push({
				type: "toolCall",
				name: part.name,
				args: asRecord(part.arguments) ?? {},
			});
		}
	}
	return items;
}

export function parseJsonEventLine(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const parsed = JSON.parse(line);
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

export function applyJsonEvent(event: Record<string, unknown>, result: SingleResult): boolean {
	const type = event.type;
	if (type === "message_update") {
		const assistantEvent = asRecord(event.assistantMessageEvent);
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			result.partialText += assistantEvent.delta;
			return true;
		}
		return false;
	}

	if (type === "tool_execution_start") {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		result.activity.push({ type: "toolCall", name: toolName, args: asRecord(event.args) ?? {} });
		return true;
	}

	if (type === "tool_execution_end") {
		const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
		const isError = event.isError === true;
		if (isError) result.activity.push({ type: "toolResult", name: toolName, isError: true, text: "tool failed" });
		return isError;
	}

	if (type === "message_end") {
		const message = asMessage(event.message);
		if (!message) return false;
		result.messages.push(message);
		result.activity.push(...messageDisplayItems(message));
		if (message.role === "assistant") {
			appendUsage(result.usage, message);
			if (message.model && !result.model) result.model = message.model;
			if (message.stopReason) result.stopReason = message.stopReason;
			if (message.errorMessage) result.errorMessage = message.errorMessage;
			result.partialText = "";
		}
		return true;
	}

	if (type === "agent_end" && Array.isArray(event.messages) && result.messages.length === 0) {
		for (const item of event.messages) {
			const message = asMessage(item);
			if (!message) continue;
			result.messages.push(message);
			result.activity.push(...messageDisplayItems(message));
			if (message.role === "assistant") {
				appendUsage(result.usage, message);
				if (message.model && !result.model) result.model = message.model;
				if (message.stopReason) result.stopReason = message.stopReason;
				if (message.errorMessage) result.errorMessage = message.errorMessage;
			}
		}
		return result.messages.length > 0;
	}

	return false;
}

export function applyJsonEventLine(line: string, result: SingleResult): boolean {
	const event = parseJsonEventLine(line);
	return event ? applyJsonEvent(event, result) : false;
}

export function getFinalOutput(messages: PiMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

export function getDisplayItems(messages: PiMessage[], fallbackActivity: DisplayItem[] = []): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) items.push(...messageDisplayItems(message));
	return items.length > 0 ? items : fallbackActivity;
}
