import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIDGE_SERVER_NAME } from "../shared/tool-bridge.ts";

/** The custom agent each run selects with --agent. */
export const AGENT_NAME = "learnharness";

const PRIVATE_FILE_MODE = 0o600;

// The agent file replaces agy's system prompt, and its empty tools list hides agy's built-in
// tools (shell, files, browser) from the model; MCP tools stay available.
function toAgentFile(systemPrompt: string): string {
	return [
		"---",
		`name: ${AGENT_NAME}`,
		"description: LearnHarness lesson agent",
		"tools: []",
		"mainAgent: true",
		"subagent: false",
		"---",
		systemPrompt,
		"",
	].join("\n");
}

// A held call lasts until the learner answers, so agy's own MCP timeouts are off
// (timeoutSeconds -1); the live-process idle timeout bounds it instead.
function toMcpConfig(url: string, authorization: string): string {
	const server = { serverUrl: url, headers: { Authorization: authorization }, timeoutSeconds: -1 };

	return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: server } });
}

/** A private workspace for one run: agy reads the agent and the MCP server from its .agents dir. */
export async function createWorkspace(systemPrompt: string, bridge: { url: string; authorization: string }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "learnharness-antigravity-"));
	const agents = join(dir, ".agents");
	await mkdir(join(agents, "agents"), { recursive: true });

	await writeFile(join(agents, "agents", `${AGENT_NAME}.md`), toAgentFile(systemPrompt), { mode: PRIVATE_FILE_MODE });
	await writeFile(join(agents, "mcp_config.json"), toMcpConfig(bridge.url, bridge.authorization), { mode: PRIVATE_FILE_MODE });

	return dir;
}

export async function removeWorkspace(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
