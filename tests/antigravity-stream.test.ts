/**
 * Antigravity provider stream (src/agent/cli-agents/antigravity/stream.ts).
 *
 * The runAgy seam spawns tests/fixtures/antigravity/fake-agy.mjs, one scenario per spawn, with the
 * real per-turn workspace and MCP bridge; recorded runs of the real agy cover the event parser.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import {
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Message,
	type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { AntigravityError } from "../src/agent/cli-agents/antigravity/constants.ts";
import { parseAgyLine } from "../src/agent/cli-agents/antigravity/events.ts";
import { toAntigravityModel } from "../src/agent/cli-agents/antigravity/provider.ts";
import { hashMessages, hashPrompt, toResponseId } from "../src/agent/cli-agents/antigravity/session.ts";
import { createAntigravityStreamFunction, toAgyArgs, toolSettleMs, type RunAgy } from "../src/agent/cli-agents/antigravity/stream.ts";

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/antigravity/", import.meta.url));

const MODEL = toAntigravityModel({ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" });
const QUIZ_TOOL: Tool = { name: "quiz", description: "Ask a quiz question", parameters: Type.Object({ question: Type.String() }) };
const PROMPT = "You are a tutor.";

toolSettleMs.current = 20;

type Scenario = { lines: string[]; conversation?: string };

type RunCall = {
	args: string[];
	env: NodeJS.ProcessEnv;
	agentFile: string;
	mcpConfig: string;
	mcpConfigMode: number;
	stdinFile: string;
	child: ChildProcessWithoutNullStreams;
};

function init(conversation = "conv-1"): string {
	return JSON.stringify({ event: "init", conversation_id: conversation, init: { model: MODEL.id, tools: [] } });
}

function response(step: number, text: string, done = true, usage?: object): string {
	const update = { conversation_id: "conv-1", step_index: step, state: done ? "DONE" : "ACTIVE", step_type: "agent_response", text_delta: text, ...(usage ? { usage } : {}) };
	return JSON.stringify({ event: "step_update", step_update: update });
}

function result(status = "SUCCESS", error?: string): string {
	return JSON.stringify({ event: "result", result: { conversation_id: "conv-1", status, response: "", ...(error ? { error } : {}) } });
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function createFakeRun(t: TestContext, scenarios: Scenario[]): { runAgy: RunAgy; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "antigravity-stream-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const calls: RunCall[] = [];

	const runAgy: RunAgy = (args, options) => {
		const scenario = scenarios[calls.length];
		assert.ok(scenario, `unexpected spawn #${calls.length + 1}`);

		const scenarioFile = join(dir, `scenario-${calls.length}.jsonl`);
		const stdinFile = join(dir, `stdin-${calls.length}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.lines.join("\n")}\n`);

		const mcpConfigFile = join(options.cwd, ".agents", "mcp_config.json");
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_STDIN: stdinFile, FAKE_AGY_CONVERSATION: scenario.conversation ?? "conv-1" },
			stdio: "pipe",
		});
		t.after(() => child.kill());

		calls.push({
			args,
			env: options.env,
			agentFile: readFileSync(join(options.cwd, ".agents", "agents", "learnharness.md"), "utf8"),
			mcpConfig: readFileSync(mcpConfigFile, "utf8"),
			mcpConfigMode: statSync(mcpConfigFile).mode & 0o777,
			stdinFile,
			child,
		});
		return child;
	};

	return { runAgy, calls };
}

async function collect(stream: AssistantMessageEventStream): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);

	return { events, message: await stream.result() };
}

function readStdinText(file: string): string {
	const line = JSON.parse(readFileSync(file, "utf8").trim()) as { event: string; message: { content: string } };
	assert.equal(line.event, "user");
	return line.message.content;
}

/** The transcript a turn sees: normalizeContext puts the system prompt first. */
function transcript(messages: Message[], systemPrompt = PROMPT): Message[] {
	return normalizeContext({ systemPrompt, messages }).messages;
}

function stamped(earlier: Message[], text: string, conversation: string, systemPrompt = PROMPT): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	message.responseId = toResponseId({ sessionId: conversation, prefixHash: hashMessages([...transcript(earlier, systemPrompt), message]), promptHash: hashPrompt(systemPrompt) });
	return message;
}

test("parses the recorded text run: text deltas, usage net of cache reads, then success", () => {
	const events = readFileSync(join(FIXTURES, "text.jsonl"), "utf8").split("\n").filter(Boolean).map(parseAgyLine);

	assert.equal(events[0]?.type, "init");
	const responses = events.filter((event) => event?.type === "response");
	assert.ok(responses.length > 0);
	assert.ok(responses.some((event) => event.text.length > 0));
	assert.ok(responses.at(-1)?.done);
	assert.deepEqual(events.at(-1), { type: "result", status: "SUCCESS" });
});

test("parses the recorded tool run: the MCP call's server, tool and arguments, ACTIVE then DONE", () => {
	const events = readFileSync(join(FIXTURES, "tool.jsonl"), "utf8").split("\n").filter(Boolean).map(parseAgyLine);
	const tools = events.filter((event) => event?.type === "mcpTool");

	assert.deepEqual(
		tools.map((event) => [event.state, event.server, event.tool, event.arguments]),
		[
			["ACTIVE", "learnharness", "quiz", { question: "What is 6 * 7?" }],
			["DONE", "learnharness", "quiz", { question: "What is 6 * 7?" }],
		],
	);
});

test("parses the recorded signed-out run as an error result", () => {
	const [event] = readFileSync(join(FIXTURES, "signed-out.jsonl"), "utf8").split("\n").filter(Boolean).map(parseAgyLine);
	assert.deepEqual(event, { type: "result", status: "ERROR", error: "authentication failed or timed out" });
});

test("agy's own tools and other MCP servers never surface as pi tool calls", () => {
	const own = { event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_info: { name: "manage_task", parameters: {} } } };
	assert.equal(parseAgyLine(JSON.stringify(own)), null);
});

test("args select the private agent and model, skip permission prompts, and resume by conversation", () => {
	const fresh = toAgyArgs({ model: "gemini-3.8-flash-low" });
	assert.deepEqual(fresh.slice(0, 8), ["--input-format", "stream-json", "--output-format", "stream-json", "--agent", "learnharness", "--model", "gemini-3.8-flash-low"]);
	assert.ok(fresh.includes("--dangerously-skip-permissions"));
	assert.ok(!fresh.includes("--conversation"));
	assert.deepEqual(fresh.slice(-2), ["-p", ""]);

	const resume = toAgyArgs({ model: "m", conversationId: "conv-9" });
	assert.equal(resume[resume.indexOf("--conversation") + 1], "conv-9");
});

test("streams text, stamps the conversation and prompt, and runs in a private workspace", async (t) => {
	process.env.GEMINI_API_KEY = "test-key";
	t.after(() => delete process.env.GEMINI_API_KEY);

	const { runAgy, calls } = createFakeRun(t, [{ lines: [init(), response(1, "Hel", false), response(1, "lo", true, { input_tokens: 120, output_tokens: 7, cache_read_tokens: 20 }), result()] }]);
	const messages = [user("hi")];
	const stream = createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages, tools: [QUIZ_TOOL] }), {});
	const { events, message } = await collect(stream);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.content, [{ type: "text", text: "Hello" }]);
	assert.deepEqual([message.usage.input, message.usage.output, message.usage.cacheRead], [100, 7, 20]);
	const prefix = normalizeContext({ systemPrompt: PROMPT, messages, tools: [QUIZ_TOOL] }).messages;
	assert.equal(message.responseId, toResponseId({ sessionId: "conv-1", prefixHash: hashMessages([...prefix, message]), promptHash: hashPrompt(PROMPT) }));

	const [call] = calls;
	assert.ok(call);
	assert.equal(readStdinText(call.stdinFile), "hi");
	assert.match(call.agentFile, /^---\nname: learnharness\n[\s\S]*tools: \[\]\n[\s\S]*---\nYou are a tutor\.\n$/);
	const server = (JSON.parse(call.mcpConfig) as { mcpServers: Record<string, { serverUrl: string; headers: { Authorization: string }; timeoutSeconds: number }> }).mcpServers.learnharness;
	assert.ok(server);
	assert.match(server.serverUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.match(server.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
	assert.equal(server.timeoutSeconds, -1);
	assert.equal(call.mcpConfigMode, 0o600);
	assert.equal(call.env.GEMINI_API_KEY, undefined);
});

test("a learner-facing call ends the turn while agy waits, and the answer continues that same process", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		{ lines: [init(), response(1, ""), JSON.stringify({ fake: "call", step: 2, name: "quiz", arguments: { question: "6*7?" } }), JSON.stringify({ fake: "reply", step: 3 }), result()] },
	]);
	const streamFn = createAntigravityStreamFunction(runAgy);
	const messages: Message[] = [user("quiz me")];

	const first = await collect(streamFn(MODEL, normalizeContext({ systemPrompt: PROMPT, messages, tools: [QUIZ_TOOL] }), {}));
	assert.equal(first.message.stopReason, "toolUse");
	const [toolCall] = first.message.content;
	assert.equal(toolCall?.type, "toolCall");
	assert.ok(toolCall?.type === "toolCall");
	assert.equal(toolCall.name, "quiz");
	assert.deepEqual(toolCall.arguments, { question: "6*7?" });
	assert.match(toolCall.id, /^agy_[0-9a-f]{32}$/);

	messages.push(first.message, { role: "toolResult", toolCallId: toolCall.id, toolName: "quiz", content: [{ type: "text", text: "42" }], isError: false, timestamp: 0 });
	const second = await collect(streamFn(MODEL, normalizeContext({ systemPrompt: PROMPT, messages, tools: [QUIZ_TOOL] }), {}));

	assert.equal(second.message.stopReason, "stop");
	assert.deepEqual(second.message.content, [{ type: "text", text: "42" }]);
	assert.equal(calls.length, 1, "the answer continued the waiting process");
	assert.match(second.message.responseId ?? "", /^ag1:conv-1:/);
});

test("a follow-up resumes the stamped conversation and sends only the new input", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [{ lines: [init("conv-7"), response(1, "again"), result()], conversation: "conv-7" }]);
	const earlier = [user("hi")];
	const messages = [...earlier, stamped(earlier, "hello", "conv-7"), user("and now?")];

	const { message } = await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages }), {}));

	assert.equal(message.stopReason, "stop");
	const [call] = calls;
	assert.ok(call);
	assert.equal(call.args[call.args.indexOf("--conversation") + 1], "conv-7");
	assert.equal(readStdinText(call.stdinFile), "and now?");
});

test("a changed system prompt starts a new conversation with a replay", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [{ lines: [init("conv-2"), response(1, "fresh"), result()], conversation: "conv-2" }]);
	const earlier = [user("hi")];
	const messages = [...earlier, stamped(earlier, "hello", "conv-7", "You are a prober."), user("and now?")];

	await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages }), {}));

	const [call] = calls;
	assert.ok(call);
	assert.ok(!call.args.includes("--conversation"));
	const text = readStdinText(call.stdinFile);
	assert.match(text, /^<conversation_record>/);
	assert.match(text, /<assistant>\nhello\n<\/assistant>/);
});

test("when agy can't find the conversation it opened a new one instead, the turn restarts with a replay", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		{ lines: [init("conv-new"), response(1, "lost context"), result()], conversation: "conv-new" },
		{ lines: [init("conv-3"), response(1, "with context"), result()], conversation: "conv-3" },
	]);
	const earlier = [user("hi")];
	const messages = [...earlier, stamped(earlier, "hello", "conv-gone"), user("and now?")];

	const { message } = await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages }), {}));

	assert.equal(calls.length, 2);
	assert.ok(calls[0]?.args.includes("--conversation"));
	assert.ok(!calls[1]?.args.includes("--conversation"));
	assert.match(readStdinText(calls[1]!.stdinFile), /^<conversation_record>/);
	assert.deepEqual(message.content, [{ type: "text", text: "with context" }]);
	assert.match(message.responseId ?? "", /^ag1:conv-3:/);
});

test("images reach agy as pi's text note, since its input takes text only", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [{ lines: [init(), response(1, "ok"), result()] }]);
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 0 }];

	await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages }), {}));

	assert.equal(readStdinText(calls[0]!.stdinFile), "look\n\n(image omitted: model does not support images)");
});

test("a signed-out agy fails the turn with 'not signed in'", async (t) => {
	const signedOut = readFileSync(join(FIXTURES, "signed-out.jsonl"), "utf8").trim();
	const { runAgy } = createFakeRun(t, [{ lines: [signedOut, JSON.stringify({ fake: "exit", code: 1 })] }]);

	const { message } = await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages: [user("hi")] }), {}));

	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, AntigravityError.NotSignedIn);
});

test("an error result fails the turn with agy's message", async (t) => {
	const { runAgy } = createFakeRun(t, [{ lines: [result("ERROR", "invalid model selection"), JSON.stringify({ fake: "exit", code: 1 })] }]);

	const { message } = await collect(createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages: [user("hi")] }), {}));

	assert.equal(message.errorMessage, "invalid model selection");
});

test("a missing agy fails the turn with 'agy CLI not found'", async () => {
	const { message } = await collect(createAntigravityStreamFunction(() => null)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages: [user("hi")] }), {}));

	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, AntigravityError.CliNotFound);
});

test("aborting kills the process and ends the turn as aborted", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [{ lines: [init(), JSON.stringify({ fake: "hold" })] }]);
	const controller = new AbortController();

	const stream = createAntigravityStreamFunction(runAgy)(MODEL, normalizeContext({ systemPrompt: PROMPT, messages: [user("hi")] }), { signal: controller.signal });
	setTimeout(() => controller.abort(), 200);
	const { message } = await collect(stream);

	assert.equal(message.stopReason, "aborted");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(calls[0]?.child.killed);
});
