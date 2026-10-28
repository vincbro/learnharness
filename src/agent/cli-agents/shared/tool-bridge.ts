import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

// The MCP server name every CLI provider sees pi's tools under.
export const BRIDGE_SERVER_NAME = "learnharness";

const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;

export type PendingToolCall = { name: string; arguments: JsonObject };

/** A localhost MCP server exposing pi's tools to one CLI run. Each call is held until pi has run
 *  the tool and resolves it; each CLI provider writes its own config pointing at url. */
export type McpBridge = {
	url: string;
	/** The Authorization header value every request must carry. */
	authorization: string;
	waitForToolCalls(count: number): Promise<PendingToolCall[]>;
	resolveToolCall(call: PendingToolCall, result: ToolResultMessage): void;
	getPendingToolCalls(): PendingToolCall[];
	close(): Promise<void>;
};

type ToolCallWaiter = {
	count: number;
	resolve: (calls: PendingToolCall[]) => void;
	reject: (error: Error) => void;
};

function toMcpContent(block: TextContent | ImageContent): CallToolResult["content"][number] {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };

		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
	}
}

function toCallToolResult(result: ToolResultMessage): CallToolResult {
	return { content: result.content.map(toMcpContent), isError: result.isError };
}

function toMcpTool(tool: Tool): McpTool {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] };
}

class ToolCallQueue {
	private readonly results = new Map<PendingToolCall, (result: CallToolResult) => void>();
	private waiters: ToolCallWaiter[] = [];

	add(call: PendingToolCall): Promise<CallToolResult> {
		const result = new Promise<CallToolResult>((resolve) => this.results.set(call, resolve));

		this.wakeWaiters();

		return result;
	}

	waitFor(count: number): Promise<PendingToolCall[]> {
		return new Promise((resolve, reject) => {
			this.waiters.push({ count, resolve, reject });
			this.wakeWaiters();
		});
	}

	resolve(call: PendingToolCall, result: ToolResultMessage): void {
		this.results.get(call)?.(toCallToolResult(result));
		this.results.delete(call);
	}

	list(): PendingToolCall[] {
		return [...this.results.keys()];
	}

	clear(): void {
		this.results.clear();

		for (const waiter of this.waiters) waiter.reject(new Error("tool bridge closed"));
		this.waiters = [];
	}

	private wakeWaiters(): void {
		const calls = this.list();

		const ready = this.waiters.filter((waiter) => calls.length >= waiter.count);
		this.waiters = this.waiters.filter((waiter) => calls.length < waiter.count);

		for (const waiter of ready) waiter.resolve(calls);
	}
}

// Low-level Server on purpose: McpServer.registerTool only takes zod schemas, and pi tools carry
// JSON Schema that must reach the CLI unchanged.
function createMcpServer(tools: Tool[], queue: ToolCallQueue): Server {
	const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	server.setRequestHandler(CallToolRequestSchema, (request) => {
		const call = { name: request.params.name, arguments: (request.params.arguments ?? {}) as JsonObject };
		return queue.add(call);
	});

	return server;
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
	if (header === undefined) return false;

	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createHttpServer(transport: StreamableHTTPServerTransport, authorization: string): http.Server {
	const expected = Buffer.from(authorization);

	return http.createServer((req, res) => {
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}

		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("CLI tool bridge request failed", error);

			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
}

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);

		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	server.closeAllConnections();

	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export async function createMcpBridge(tools: Tool[]): Promise<McpBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;

	const queue = new ToolCallQueue();
	const mcpServer = createMcpServer(tools, queue);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcpServer.connect(transport);

	const httpServer = createHttpServer(transport, authorization);
	const { port } = await listen(httpServer);

	return {
		url: `http://${LOOPBACK_HOST}:${port}/mcp`,
		authorization,
		waitForToolCalls: (count) => queue.waitFor(count),
		resolveToolCall: (call, result) => queue.resolve(call, result),
		getPendingToolCalls: () => queue.list(),
		close: async () => {
			queue.clear();
			await mcpServer.close();
			await closeHttpServer(httpServer);
		},
	};
}
