import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import packageMcp, { childWithoutMcp, readPackageServers } from "../../package-mcp.ts";

test("childWithoutMcp only disables MCP for subagent children without MCP tools", () => {
	const argv = (...extra: string[]) => ["node", "pi", ...extra];
	assert.equal(childWithoutMcp({}, argv("--tools", "read")), false, "top-level session");
	assert.equal(childWithoutMcp({ PI_SUBAGENT_DEPTH: "1" }, argv()), false, "default tools");
	assert.equal(childWithoutMcp({ PI_SUBAGENT_DEPTH: "1" }, argv("--tools", "read,grep")), true);
	assert.equal(childWithoutMcp({ PI_SUBAGENT_DEPTH: "1" }, argv("--no-tools")), true);
	assert.equal(childWithoutMcp({ PI_SUBAGENT_DEPTH: "1" }, argv("--tools", "read,codemode")), false);
	assert.equal(childWithoutMcp({ PI_SUBAGENT_DEPTH: "2" }, argv("-t", "mcp__ado__get")), false);
});

test("package servers are read in settings order and registered, later packages replacing earlier", () => {
	const agent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-pkg-mcp-")));
	const a = path.join(agent, "a");
	const b = path.join(agent, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	fs.writeFileSync(path.join(a, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "a" }, onlyA: { url: "https://a" } } }));
	fs.writeFileSync(path.join(b, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "b" } } }));
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["./a", "./b"] }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const { entries, errors } = readPackageServers("/nowhere", "user", false);
		assert.deepEqual(errors, []);
		assert.deepEqual(entries.map((entry) => `${entry.name}:${JSON.stringify(entry.config)}`), [
			'shared:{"command":"a"}',
			'onlyA:{"url":"https://a"}',
			'shared:{"command":"b"}',
		]);

		const registered = new Map<string, unknown>();
		packageMcp({
			registerMcpServer: (name: string, config: unknown) => registered.set(name, config),
			registerCommand: () => assert.fail("must not stub /mcp in a top-level session"),
			on: () => () => {},
		} as never);
		assert.deepEqual(Object.fromEntries(registered), { shared: { command: "b" }, onlyA: { url: "https://a" } });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
