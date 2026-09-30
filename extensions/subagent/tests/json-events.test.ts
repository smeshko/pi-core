import test from "node:test";
import assert from "node:assert/strict";
import { applyJsonEventLine, getDisplayItems, getFinalOutput, parseJsonEventLine } from "../json-events.ts";
import { createBaseResult } from "../runner.ts";

test("parseJsonEventLine ignores malformed JSON", () => {
	assert.equal(parseJsonEventLine("not json"), undefined);
	assert.equal(parseJsonEventLine(""), undefined);
});

test("captures message_end final output, usage, model, and stop reason", () => {
	const result = createBaseResult("scout", "task");
	applyJsonEventLine(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 }, totalTokens: 30 },
				model: "test-model",
				stopReason: "end",
			},
		}),
		result,
	);
	assert.equal(getFinalOutput(result.messages), "final answer");
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cost, 0.01);
	assert.equal(result.usage.contextTokens, 30);
	assert.equal(result.model, "test-model");
	assert.equal(result.stopReason, "end");
});

test("captures tool execution starts as streaming activity", () => {
	const result = createBaseResult("scout", "task");
	const changed = applyJsonEventLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } }), result);
	assert.equal(changed, true);
	assert.deepEqual(result.activity, [{ type: "toolCall", name: "read", args: { path: "README.md" } }]);
});

test("extracts tool calls from assistant messages", () => {
	const result = createBaseResult("scout", "task");
	applyJsonEventLine(
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" } }] },
		}),
		result,
	);
	assert.deepEqual(getDisplayItems(result.messages), [{ type: "toolCall", name: "grep", args: { pattern: "foo" } }]);
});
