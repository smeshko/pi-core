import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectMemoryFiles } from "../src/collect.ts";

test("memory walk stays in cwd unless cwd is a git root with AGENTS.md", () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-")));
	fs.mkdirSync(path.join(dir, "deep", "er"), { recursive: true });
	fs.writeFileSync(path.join(dir, "deep", "er", "AGENTS.md"), "nested");
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "top");

	const names = () => collectMemoryFiles(dir, new Set()).map((file) => file.path).filter((p) => !p.startsWith("~") && !p.startsWith("/"));

	assert.deepEqual(names(), ["CLAUDE.md"]);

	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "root");
	assert.deepEqual(names().sort(), ["AGENTS.md", "CLAUDE.md", path.join("deep", "er", "AGENTS.md")].sort());
});
