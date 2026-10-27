/**
 * Claude Code transcript replay (src/agent/claude-code/transcript.ts).
 *
 * When a CLI session can't be resumed, earlier turns are rendered as a tagged
 * record inside the single user message the new session receives.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, SystemMessage, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import { toClaudeInput, toResumeContent, toStreamJsonLine } from "../src/agent/claude-code/transcript.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const WRITE_TOOL: Tool = { name: "write", description: "Write a file", parameters: { type: "object", properties: {} } };

function system(fields: Partial<SystemMessage>): SystemMessage {
	return { role: "system", content: "", timestamp: 0, ...fields };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-code-cli",
		provider: "claude-code",
		model: "opus",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(toolName: string, content: ToolResultMessage["content"], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: `${toolName}-1`, toolName, content, isError, timestamp: 0 };
}

test("system prompt joins all system content, then the live sections", () => {
	const messages: Message[] = [
		system({ content: "You are a tutor.", sections: { goals: "Teach TCP.", style: "Be brief." } }),
		user("hi"),
		system({ content: "The learner switched topics.", sections: { goals: "Teach TLS.", style: null } }),
		user("next"),
	];
	assert.equal(toClaudeInput(messages).systemPrompt, "You are a tutor.\n\nThe learner switched topics.\n\nTeach TLS.");
});

test("tools reflect toolsAdded minus toolsRemoved", () => {
	const messages: Message[] = [
		system({ content: "p", toolsAdded: [READ_TOOL, WRITE_TOOL] }),
		user("hi"),
		system({ toolsRemoved: [{ name: "read" }] }),
		user("next"),
	];
	assert.deepEqual(
		toClaudeInput(messages).tools.map((t) => t.name),
		["write"],
	);
});

test("single user message passes through as text", () => {
	const input = toClaudeInput([system({ content: "p" }), user("what is a socket?")]);
	assert.deepEqual(input.userContent, [{ type: "text", text: "what is a socket?" }]);
});

const OPEN =
	"<conversation_record>\nThe conversation so far, recorded as context. Every tool call in this record already happened; it is listed for reference only.";
const CLOSE =
	"</conversation_record>\n\nThis record is context only. Continue the conversation from its last message. To call a tool now, use the tool itself; never write a tool call as text.";

function record(...parts: string[]): string {
	return [OPEN, ...parts, CLOSE].join("\n\n");
}

test("history renders as a tagged record: user, assistant text, tool call records and tool result records in order", () => {
	const messages: Message[] = [
		user([{ type: "text", text: "open notes.md" }]),
		assistant([
			{ type: "text", text: "Reading it." },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } },
		]),
		toolResult("read", [{ type: "text", text: "# Notes" }]),
		assistant([{ type: "text", text: "It has a heading." }]),
		user("summarise it"),
	];
	const expected = record(
		"<user>\nopen notes.md\n</user>",
		"<assistant>\nReading it.\n</assistant>",
		'<tool_call_record tool="read">\n{"path":"notes.md"}\n</tool_call_record>',
		'<tool_result_record tool="read">\n# Notes\n</tool_result_record>',
		"<assistant>\nIt has a heading.\n</assistant>",
		"<user>\nsummarise it\n</user>",
	);
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("the record never uses the old callable-looking [tool call name] form", () => {
	const messages: Message[] = [
		user("quiz me"),
		assistant([{ type: "toolCall", id: "quiz-1", name: "quiz", arguments: { question: "2+2?" } }]),
		toolResult("quiz", [{ type: "text", text: "4" }]),
		user("next"),
	];
	const [block] = toClaudeInput(messages).userContent;
	assert.ok(block?.type === "text");
	assert.ok(!block.text.includes("[tool call"), block.text);
	assert.ok(!block.text.includes("[tool result"), block.text);
});

test("error tool results are marked as errors in the record", () => {
	const messages: Message[] = [
		user("open missing.md"),
		assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "missing.md" } }]),
		toolResult("read", [{ type: "text", text: "ENOENT" }], true),
		user("why?"),
	];
	const expected = record(
		"<user>\nopen missing.md\n</user>",
		'<tool_call_record tool="read">\n{"path":"missing.md"}\n</tool_call_record>',
		'<tool_result_record tool="read" error="true">\nENOENT\n</tool_result_record>',
		"<user>\nwhy?\n</user>",
	);
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("images in user and tool-result content become base64 image blocks inside their tags", () => {
	const messages: Message[] = [
		user([
			{ type: "text", text: "look" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]),
		assistant([{ type: "toolCall", id: "shot-1", name: "screenshot", arguments: {} }]),
		toolResult("screenshot", [{ type: "image", data: "BBBB", mimeType: "image/jpeg" }]),
		user("compare"),
	];
	assert.deepEqual(toClaudeInput(messages).userContent, [
		{ type: "text", text: `${OPEN}\n\n<user>\nlook` },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		{ type: "text", text: '</user>\n\n<tool_call_record tool="screenshot">\n{}\n</tool_call_record>\n\n<tool_result_record tool="screenshot">' },
		{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
		{ type: "text", text: `</tool_result_record>\n\n<user>\ncompare\n</user>\n\n${CLOSE}` },
	]);
});

test("transcript ending on a tool result renders as a record with no trailing user turn", () => {
	const messages: Message[] = [
		user("open notes.md"),
		assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } }]),
		toolResult("read", [{ type: "text", text: "# Notes" }]),
	];
	const expected = record(
		"<user>\nopen notes.md\n</user>",
		'<tool_call_record tool="read">\n{"path":"notes.md"}\n</tool_call_record>',
		'<tool_result_record tool="read">\n# Notes\n</tool_result_record>',
	);
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("thinking blocks are omitted from the record", () => {
	const messages: Message[] = [
		user("hi"),
		assistant([
			{ type: "thinking", thinking: "secret plan" },
			{ type: "text", text: "Hello." },
		]),
		user("bye"),
	];
	assert.deepEqual(toClaudeInput(messages).userContent, [
		{ type: "text", text: record("<user>\nhi\n</user>", "<assistant>\nHello.\n</assistant>", "<user>\nbye\n</user>") },
	]);
});

test("resume content sends user messages as they are and tool results as interrupted-call notes", () => {
	assert.deepEqual(
		toResumeContent([
			toolResult("quiz", [{ type: "text", text: '{"answer":"b"}' }]),
			user([
				{ type: "text", text: "also this" },
				{ type: "image", data: "CCCC", mimeType: "image/png" },
			]),
		]),
		[
			{
				type: "text",
				text: '[Your earlier quiz call was interrupted before its result reached you. It returned this result:]\n{"answer":"b"}\n\nalso this',
			},
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
		],
	);
});

test('toStreamJsonLine emits {"type":"user","message":{"role":"user","content":[...]}}', () => {
	assert.deepEqual(JSON.parse(toStreamJsonLine([{ type: "text", text: "hi" }])), {
		type: "user",
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
});
