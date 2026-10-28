/**
 * Stand-in for the agy CLI in tests. Reads the stream-json input from stdin, then replays the
 * scenario file named by FAKE_AGY_SCENARIO line by line. Lines with a "fake" key are directives
 * instead of output:
 *   {"fake":"hold"}                                   stay alive until killed, like agy waiting on a held MCP call
 *   {"fake":"exit","code":1,"stderr":"..."}           write stderr and exit with that code
 *   {"fake":"call","step":2,"name":"read","arguments":{...}}
 *       report an ACTIVE call_mcp_tool step, call that tool on the MCP bridge (read from the
 *       workspace's .agents/mcp_config.json) and wait for its result, then report the step DONE
 *   {"fake":"reply","step":3}                         a DONE agent_response whose text is every result so far, joined by " | "
 * FAKE_AGY_STDIN, when set, receives the stdin it read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOLD_INTERVAL_MS = 60_000;
const BRIDGE_SERVER_NAME = "learnharness";
const CONVERSATION_ID = process.env.FAKE_AGY_CONVERSATION ?? "conv-1";

function writeLine(line) {
	return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
}

function stepUpdate(update) {
	return JSON.stringify({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, ...update } });
}

async function connectBridge() {
	const config = JSON.parse(readFileSync(join(process.cwd(), ".agents", "mcp_config.json"), "utf8"));
	const { serverUrl, headers } = config.mcpServers[BRIDGE_SERVER_NAME];
	const client = new Client({ name: "fake-agy", version: "1.0.0" });

	await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers } }));
	return client;
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_AGY_STDIN) writeFileSync(process.env.FAKE_AGY_STDIN, input);

let bridge = null;
const results = [];
const lines = readFileSync(process.env.FAKE_AGY_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
	const directive = JSON.parse(line);

	if (directive.fake === "hold") {
		setInterval(() => {}, HOLD_INTERVAL_MS);
		break;
	}

	if (directive.fake === "exit") {
		process.stderr.write(directive.stderr ?? "");
		process.exit(directive.code);
	}

	if (directive.fake === "call") {
		const parameters = { Arguments: directive.arguments, ServerName: BRIDGE_SERVER_NAME, ToolName: directive.name };
		await writeLine(stepUpdate({ step_index: directive.step, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters } }));

		bridge ??= await connectBridge();
		const result = await bridge.callTool({ name: directive.name, arguments: directive.arguments });
		const output = result.content.map((block) => block.text).join("");
		results.push(output);

		await writeLine(stepUpdate({ step_index: directive.step, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters, output } }));
		continue;
	}

	if (directive.fake === "reply") {
		await writeLine(stepUpdate({ step_index: directive.step, state: "DONE", step_type: "agent_response", text_delta: results.join(" | ") }));
		continue;
	}

	await writeLine(line);
}
