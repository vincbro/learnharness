import type { JsonObject, Usage } from "@earendil-works/pi-ai";

export type AgyUsage = Pick<Usage, "input" | "output" | "cacheRead">;

/** What a run reports, reduced to what a turn needs. agy's own tools (e.g. manage_task) are
 *  dropped: only MCP calls can reach pi. */
export type AgyEvent =
	| { type: "init"; conversationId: string }
	/** An agent_response step. Its text may arrive in ACTIVE updates, in the closing DONE, or both. */
	| { type: "response"; step: number; text: string; done: boolean; usage?: AgyUsage }
	| { type: "mcpTool"; step: number; state: string; server: string; tool: string; arguments: JsonObject }
	| { type: "result"; status: string; error?: string };

type RawUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_tokens?: unknown };

type RawStepUpdate = {
	step_index?: unknown;
	state?: unknown;
	step_type?: unknown;
	text_delta?: unknown;
	usage?: RawUsage;
	tool_info?: { name?: unknown; parameters?: { ServerName?: unknown; ToolName?: unknown; Arguments?: unknown } };
};

type RawLine = {
	event?: string;
	conversation_id?: unknown;
	step_update?: RawStepUpdate;
	result?: { status?: unknown; error?: unknown };
};

const MCP_TOOL = "call_mcp_tool";

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// input_tokens includes cache reads; they are reported apart, as for other providers.
function toUsage(raw: RawUsage): AgyUsage {
	const cacheRead = count(raw.cache_read_tokens);

	return { input: Math.max(0, count(raw.input_tokens) - cacheRead), output: count(raw.output_tokens), cacheRead };
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStep(step: RawStepUpdate): AgyEvent | null {
	if (typeof step.step_index !== "number" || typeof step.state !== "string") return null;

	switch (step.step_type) {
		case "agent_response": {
			const text = typeof step.text_delta === "string" ? step.text_delta : "";
			const done = step.state === "DONE";
			return step.usage ? { type: "response", step: step.step_index, text, done, usage: toUsage(step.usage) } : { type: "response", step: step.step_index, text, done };
		}

		case "tool": {
			const info = step.tool_info;
			if (info?.name !== MCP_TOOL) return null;

			const { ServerName, ToolName, Arguments } = info.parameters ?? {};
			if (typeof ServerName !== "string" || typeof ToolName !== "string") return null;

			const args = isJsonObject(Arguments) ? Arguments : {};
			return { type: "mcpTool", step: step.step_index, state: step.state, server: ServerName, tool: ToolName, arguments: args };
		}

		default:
			return null;
	}
}

export function parseAgyLine(text: string): AgyEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;

	const line = parsed as RawLine;

	switch (line.event) {
		case "init":
			return typeof line.conversation_id === "string" ? { type: "init", conversationId: line.conversation_id } : null;

		case "step_update":
			return line.step_update ? parseStep(line.step_update) : null;

		case "result": {
			const status = typeof line.result?.status === "string" ? line.result.status : "UNKNOWN";
			const error = line.result?.error;
			return typeof error === "string" && error ? { type: "result", status, error } : { type: "result", status };
		}

		default:
			return null;
	}
}
