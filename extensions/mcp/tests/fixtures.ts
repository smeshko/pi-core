/**
 * Real tool inventories, so search regressions show up against the corpus that produced
 * them. ADO is a live `tools/list` capture; Figma and the simulator are trimmed to the
 * entries that matter for cross-server bleed.
 */

import { describeTool, piToolName, type RegisteredMcpTool } from "../src/tools.ts";

const ADO: Array<[string, string]> = [
	["core_list_project_teams", "Retrieve a list of teams for an Azure DevOps project."],
	["core_list_projects", "Retrieve a list of projects in your Azure DevOps organization."],
	["core_get_identity_ids", "Retrieve Azure DevOps identity IDs for a provided search filter."],
	["work", "Retrieve work-related data for a project or team."],
	["work_iteration_write", "Create or assign iterations in an Azure DevOps project."],
	["work_capacity_write", "Update the team capacity of a team member for a specific iteration in a project."],
	["pipelines_build", "Retrieve build data for a project."],
	["pipelines_build_log", "Retrieve build log data for a project."],
	["pipelines_definition", "Retrieve pipeline definition data for a project."],
	["pipelines_run", "Retrieve pipeline run data for a project."],
	["pipelines_artifact", "Retrieve and download build artifacts."],
	["pipelines_write", "Write operations for pipelines and builds."],
	["repo_repository", "Retrieve repository data for an organization or project."],
	["repo_pull_request", "Retrieve pull request data."],
	["repo_pull_request_thread", "Retrieve pull request thread and comment data."],
	["repo_branch", "Retrieve branch data for a repository."],
	["repo_file", "Retrieve file data from a repository."],
	["repo_search_commits", "Search commits with filtering by text, author, date range, and more."],
	["repo_pull_request_write", "Write operations for pull requests."],
	["repo_pull_request_thread_write", "Write operations for pull request comment threads."],
	["repo_create_branch", "Create a new branch in the repository."],
	["wit_work_item", "Retrieve work item data for a project."],
	["wit_query", "Retrieve work item query data for a project."],
	["wit_backlog", "Retrieve backlog data for a project and team."],
	["wit_work_item_attachment", "Download a work item attachment by its ID."],
	["wit_work_item_write", "Write operations for work items."],
	["wit_work_item_comment_write", "Write operations for work item comments."],
	["wit_work_item_link_write", "Write operations for work item links."],
	["wiki", "Retrieve wiki data for an organization or project."],
	["wiki_upsert_page", "Create or update a wiki page with content."],
	["testplan", "Retrieve paginated test plan, suite, and case data for a project."],
	["testplan_show_test_results_from_build_id", "Gets a list of test results for a given project and build ID."],
	["testplan_test_plan_write", "Write operations for test plans."],
	["testplan_test_suite_write", "Write operations for test suites."],
	["testplan_test_case_write", "Write operations for test cases."],
	["search_code", "Search Azure DevOps Repositories for a given search text"],
	["search_wiki", "Search Azure DevOps Wiki for a given search text"],
	["search_workitem", "Get Azure DevOps Work Item search results for a given search text"],
	["advsec_get_alerts", "Retrieve Advanced Security alerts for a repository."],
	["advsec_get_alert_details", "Get detailed information about a specific Advanced Security alert."],];

const FIGMA: Array<[string, string]> = [
	["get_code", "Generate code for the selected Figma node. Use this to convert a design into a component."],
	["get_design_context", "Get the design context of the current selection, including layout, styles and text."],
	["get_screenshot", "Take a screenshot of the current Figma selection."],
	["get_metadata", "Get an XML representation of the selected node and its children with ids and positions."],
	["get_variable_defs", "Get the variables and styles used by the current selection."],
	["list_file_components_for_code_connect", "List the components in a Figma file that can be mapped and updated for Code Connect."],
	["create_design_system_rules", "Create a design system rules file for this project."],
	["add_figma_file", "Add a Figma file to the current context so its designs can be read."],
];

const SIMULATOR: Array<[string, string]> = [
	["ui_describe_all", "Describe the accessibility tree of the running iOS simulator app."],
	["ui_tap", "Tap on a coordinate in the iOS simulator."],
	["ui_type", "Type text into the focused field in the iOS simulator."],
	["screenshot", "Take a screenshot of the iOS simulator screen."],
	["record_video", "Record a video of the iOS simulator screen."],
];

function build(serverName: string, entries: Array<[string, string]>): RegisteredMcpTool[] {
	return entries.map(([remoteName, description]) => ({
		piName: piToolName(serverName, remoteName),
		serverName,
		remoteName,
		description: describeTool({ remoteName, description, inputSchema: {} }, serverName),
	}));
}

export const adoTools = build("ado-remote-mcp", ADO);
export const figmaTools = build("figma-remote", FIGMA);
export const simulatorTools = build("ios-simulator", SIMULATOR);
export const allTools = [...adoTools, ...figmaTools, ...simulatorTools];
