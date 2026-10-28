import type { Tool } from "@earendil-works/pi-ai";

import { BRIDGE_SERVER_NAME, createMcpBridge, type McpBridge, type PendingToolCall } from "../cli-agents/shared/tool-bridge.ts";

export { BRIDGE_SERVER_NAME, type PendingToolCall };

const MCP_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

export type ToolBridge = Omit<McpBridge, "url" | "authorization"> & {
	mcpConfig: string;
	allowedTools: string[];
};

export function toolNameFromMcp(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function toMcpConfig(url: string, authorization: string): string {
	const server = { type: "http", url, headers: { Authorization: authorization } };

	return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: server } });
}

export async function createToolBridge(tools: Tool[]): Promise<ToolBridge> {
	const { url, authorization, ...bridge } = await createMcpBridge(tools);

	return {
		...bridge,
		mcpConfig: toMcpConfig(url, authorization),
		allowedTools: tools.map((tool) => `${MCP_TOOL_PREFIX}${tool.name}`),
	};
}
