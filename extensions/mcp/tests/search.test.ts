import assert from "node:assert/strict";
import test from "node:test";

import { queryTerms, searchTools } from "../src/search.ts";
import { adoTools, allTools, figmaTools } from "./fixtures.ts";

function names(query: string, limit = 6, tools = allTools): string[] {
	return searchTools(tools, query, limit).map((match) => match.tool.remoteName);
}

function servers(query: string, limit = 6): string[] {
	return [...new Set(searchTools(allTools, query, limit).map((match) => match.tool.serverName))];
}

test("keeps a multi-intent Azure DevOps query inside the Azure DevOps server", () => {
	// Regression: filler words ("list", "for", "and") used to score a Figma tool above repo_branch.
	const result = names("Azure DevOps list pull requests for branch and update pull request");

	assert.deepEqual(servers("Azure DevOps list pull requests for branch and update pull request"), ["ado-remote-mcp"]);
	assert.ok(result.includes("repo_pull_request"), `expected repo_pull_request in ${result.join(", ")}`);
	assert.ok(result.includes("repo_branch"), `expected repo_branch in ${result.join(", ")}`);
	assert.ok(
		result.every((name) => name.includes("pull_request") || name.includes("branch")),
		`unrelated tools leaked in: ${result.join(", ")}`,
	);
});

test("weighs domain nouns above operation verbs", () => {
	assert.deepEqual(queryTerms("Can you please use the api to get all of my pull requests?"), ["get", "pull", "request"]);
	assert.deepEqual(queryTerms("and for the with"), []);
	// "list" is a weaker signal than "pipelines", so the pipeline tools must come first.
	assert.ok(names("list all pipelines", 3).every((name) => name.startsWith("pipelines")));
});

test("keeps product names whole instead of splitting camelCase prose", () => {
	// "DevOps" must not become "dev" + "ops", which turns one concept into two weak votes.
	assert.equal(queryTerms("DevOps").length, 1);
	assert.ok(!queryTerms("DevOps").includes("dev"));
	// Identifiers still split, so the halves of a tool name remain searchable.
	assert.equal(names("upsert a wiki page")[0], "wiki_upsert_page");
});

test("routes a query to the server it names", () => {
	assert.deepEqual(servers("read the figma design of the selected frame"), ["figma-remote"]);
	assert.deepEqual(servers("tap a button in the ios simulator"), ["ios-simulator"]);
	assert.deepEqual(servers("show the work item and its comments"), ["ado-remote-mcp"]);
});

test("ranks the specific tool above its neighbours", () => {
	assert.equal(names("create a branch")[0], "repo_create_branch");
	assert.equal(names("search the wiki")[0], "search_wiki");
	assert.equal(names("get the figma design context for the selection")[0], "get_design_context");
	assert.equal(names("download a build artifact")[0], "pipelines_artifact");
});

test("matches plural and derived forms", () => {
	assert.ok(names("list all pipeline definitions").includes("pipelines_definition"));
	assert.ok(names("show the branches of a repository").includes("repo_branch"));
});

test("ignores a term nothing can match instead of sinking every score", () => {
	const result = names("frobnicate the pull request");
	assert.ok(result.includes("repo_pull_request"), `expected repo_pull_request in ${result.join(", ")}`);
});

test("returns the single best guess when nothing matches well", () => {
	const result = searchTools(allTools, "provision a kubernetes cluster", 6);
	assert.ok(result.length <= 1, `expected at most one weak guess, got ${result.map((m) => m.tool.remoteName).join(", ")}`);
});

test("honours the limit and the server filter", () => {
	assert.equal(names("pull request", 2).length, 2);
	assert.deepEqual(
		[...new Set(searchTools(figmaTools, "list components", 3).map((match) => match.tool.serverName))],
		["figma-remote"],
	);
});

test("still scores descriptions when only one server is configured", () => {
	// The identity-term rule must not fire on a single-server corpus, where every term
	// trivially belongs to exactly one server.
	const result = names("advanced security alerts for the repository", 3, adoTools);
	assert.deepEqual(result.slice(0, 2).sort(), ["advsec_get_alert_details", "advsec_get_alerts"]);
});

test("returns the head of the corpus for an empty query", () => {
	const result = searchTools(allTools, "   ", 3);
	assert.deepEqual(
		result.map((match) => match.tool.piName),
		allTools.slice(0, 3).map((tool) => tool.piName),
	);
});

test("handles an empty corpus", () => {
	assert.deepEqual(searchTools([], "anything", 5), []);
});
