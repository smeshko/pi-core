import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { packageRoots } from "../package-roots.ts";
import { discoverRuleFiles, skipReason } from "../nested-agents.ts";

function tmp(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-")));
}

test("packageRoots resolves local, git and npm sources in order and skips missing ones", () => {
	const agent = tmp();
	const local = path.join(agent, "..", path.basename(agent) + "-local");
	fs.mkdirSync(local);
	fs.mkdirSync(path.join(agent, "git", "github.com", "me", "pi-core"), { recursive: true });
	fs.mkdirSync(path.join(agent, "npm", "node_modules", "@me", "tools"), { recursive: true });
	fs.writeFileSync(
		path.join(agent, "settings.json"),
		JSON.stringify({
			packages: [
				`../${path.basename(local)}`,
				"git:github.com/me/pi-core@v1",
				{ source: "npm:@me/tools@1.0.0" },
				"./does-not-exist",
			],
		}),
	);

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const roots = packageRoots("/nowhere").map((pkg) => pkg.root);
		assert.deepEqual(roots, [
			fs.realpathSync(local),
			path.join(agent, "git", "github.com", "me", "pi-core"),
			path.join(agent, "npm", "node_modules", "@me", "tools"),
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("nested rule discovery skips a cwd that is not a git root with AGENTS.md", () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "sub"));
	fs.writeFileSync(path.join(dir, "sub", "AGENTS.md"), "rules");

	assert.deepEqual(discoverRuleFiles(dir), []);
	assert.equal(skipReason(), "cwd is not a git repository root");

	fs.mkdirSync(path.join(dir, ".git"));
	assert.deepEqual(discoverRuleFiles(dir), []);
	assert.equal(skipReason(), "cwd has no AGENTS.md");

	fs.writeFileSync(path.join(dir, "AGENTS.md"), "root rules");
	assert.deepEqual(discoverRuleFiles(dir).map((file) => file.relPath), [path.join("sub", "AGENTS.md")]);
	assert.equal(skipReason(), undefined);
});
