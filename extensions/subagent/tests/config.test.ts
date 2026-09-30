import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	applyToolParamOverrides,
	buildChildEnv,
	buildRuntimeArgs,
	loadSubagentConfig,
	shouldRegisterSubagentTool,
} from "../config.ts";

async function tempDir() {
	return mkdtemp(join(tmpdir(), "subagent-config-test-"));
}

test("defaults load both user and project agents without confirmation", () => {
	assert.equal(DEFAULT_CONFIG.agentScope, "both");
	assert.equal(DEFAULT_CONFIG.confirmProjectAgents, false);
	assert.equal(DEFAULT_CONFIG.defaultTools, undefined);
	assert.equal(DEFAULT_CONFIG.runtime.extensions.mode, "inherit");
});

test("loads user config then nearest project config with project precedence", async () => {
	const root = await tempDir();
	const userConfig = join(root, "subagent.config.json");
	const repo = join(root, "repo");
	await mkdir(join(repo, ".pi"), { recursive: true });
	await writeFile(userConfig, JSON.stringify({ agentScope: "user", maxConcurrency: 2, defaultTools: ["read"] }));
	await writeFile(join(repo, ".pi", "subagent.config.json"), JSON.stringify({ agentScope: "both", maxConcurrency: 3 }));

	const loaded = loadSubagentConfig(repo, { userConfigPath: userConfig });
	assert.equal(loaded.config.agentScope, "both");
	assert.equal(loaded.config.maxConcurrency, 3);
	assert.deepEqual(loaded.config.defaultTools, ["read"]);
	assert.equal(loaded.loadedPaths.length, 2);
});

test("builds runtime args for allowlists and none policies", () => {
	const args = buildRuntimeArgs({
		extensions: { mode: "allowlist", allow: ["/a/ext.ts", "/b/ext.ts"] },
		skills: { mode: "none", allow: [] },
		promptTemplates: { mode: "inherit", allow: [] },
		contextFiles: "none",
	});
	assert.deepEqual(args, ["--no-extensions", "--extension", "/a/ext.ts", "--extension", "/b/ext.ts", "--no-skills", "--no-context-files"]);
});

test("tool param overrides can restrict tools and runtime", () => {
	const config = applyToolParamOverrides(DEFAULT_CONFIG, {
		tools: ["read", "grep"],
		runtime: { contextFiles: "none", extensions: { mode: "none" } },
	}, "/tmp");
	assert.deepEqual(config.defaultTools, ["read", "grep"]);
	assert.equal(config.runtime.contextFiles, "none");
	assert.equal(config.runtime.extensions.mode, "none");
});

test("child env increments PI_SUBAGENT_DEPTH", () => {
	const env = buildChildEnv({ PI_SUBAGENT_DEPTH: "2" }, DEFAULT_CONFIG);
	assert.equal(env.PI_SUBAGENT_DEPTH, "3");
});

test("recursion is blocked by default and allowed only with config", () => {
	assert.equal(shouldRegisterSubagentTool(DEFAULT_CONFIG, 0), true);
	assert.equal(shouldRegisterSubagentTool(DEFAULT_CONFIG, 1), false);
	assert.equal(shouldRegisterSubagentTool({ ...DEFAULT_CONFIG, recursion: { allow: true, maxDepth: 3 } }, 1), true);
	assert.equal(shouldRegisterSubagentTool({ ...DEFAULT_CONFIG, recursion: { allow: true, maxDepth: 3 } }, 3), false);
});
