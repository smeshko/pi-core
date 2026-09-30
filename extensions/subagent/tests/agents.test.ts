import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, parseAgentMarkdown } from "../agents.ts";

async function tempDir() {
	return mkdtemp(join(tmpdir(), "subagent-agents-test-"));
}

test("parses agent frontmatter and comma-separated tools", () => {
	const parsed = parseAgentMarkdown(
		`---\nname: scout\ndescription: Fast recon\ntools: read, grep, find\nmodel: test-model\n---\nPrompt body`,
		"/tmp/scout.md",
		"user",
	);
	assert.equal(parsed.diagnostics.filter((item) => item.level === "error").length, 0);
	assert.equal(parsed.agent?.name, "scout");
	assert.deepEqual(parsed.agent?.tools, ["read", "grep", "find"]);
	assert.equal(parsed.agent?.model, "test-model");
	assert.equal(parsed.agent?.systemPrompt, "Prompt body");
});

test("skips invalid agent files with diagnostics", () => {
	const parsed = parseAgentMarkdown(`---\ndescription: Missing name\n---\nPrompt`, "/tmp/bad.md", "project");
	assert.equal(parsed.agent, undefined);
	assert.ok(parsed.diagnostics.some((item) => item.message.includes("name")));
});

test("discovers user and project agents by default and project overrides user", async () => {
	const root = await tempDir();
	const userDir = join(root, "user-agents");
	const projectDir = join(root, "repo", ".pi", "agents");
	await mkdir(userDir, { recursive: true });
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(userDir, "scout.md"), `---\nname: scout\ndescription: User scout\n---\nUser prompt`);
	await writeFile(join(userDir, "planner.md"), `---\nname: planner\ndescription: User planner\n---\nPlanner prompt`);
	await writeFile(join(projectDir, "scout.md"), `---\nname: scout\ndescription: Project scout\n---\nProject prompt`);

	const result = discoverAgents(join(root, "repo"), "both", { userAgentsDir: userDir });
	assert.equal(result.projectAgentsDir, projectDir);
	assert.deepEqual(result.agents.map((agent) => `${agent.name}:${agent.source}:${agent.description}`), [
		"planner:user:User planner",
		"scout:project:Project scout",
	]);
});

test("supports user-only and project-only scopes", async () => {
	const root = await tempDir();
	const userDir = join(root, "user-agents");
	const projectDir = join(root, "repo", ".pi", "agents");
	await mkdir(userDir, { recursive: true });
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(userDir, "user.md"), `---\nname: user\ndescription: User only\n---\nPrompt`);
	await writeFile(join(projectDir, "project.md"), `---\nname: project\ndescription: Project only\n---\nPrompt`);

	assert.deepEqual(discoverAgents(join(root, "repo"), "user", { userAgentsDir: userDir }).agents.map((a) => a.name), ["user"]);
	assert.deepEqual(discoverAgents(join(root, "repo"), "project", { userAgentsDir: userDir }).agents.map((a) => a.name), ["project"]);
});

test("package agents load before profile agents, which override them by name", async () => {
	const root = await tempDir();
	const pkgDir = join(root, "pkg", "agents");
	const userDir = join(root, "profile", "agents");
	await mkdir(pkgDir, { recursive: true });
	await mkdir(userDir, { recursive: true });
	await writeFile(join(pkgDir, "shared.md"), "---\nname: shared\ndescription: from package\n---\nbody");
	await writeFile(join(pkgDir, "pkgonly.md"), "---\nname: pkgonly\ndescription: package only\n---\nbody");
	await writeFile(join(userDir, "shared.md"), "---\nname: shared\ndescription: from profile\n---\nbody");

	const result = discoverAgents(root, "user", { userAgentsDir: userDir, packageAgentsDirs: [pkgDir], projectAgentsDir: null });
	assert.deepEqual(result.agents.map((a) => `${a.name}:${a.description}`), ["pkgonly:package only", "shared:from profile"]);
});
