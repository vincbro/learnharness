/**
 * Antigravity session stamps (src/agent/cli-agents/antigravity/session.ts) and agy lookup
 * (src/agent/cli-agents/antigravity/binary.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

import { resolveAgyBinary } from "../src/agent/cli-agents/antigravity/binary.ts";
import { hashMessages, hashPrompt, parseResponseId, planSession, toResponseId } from "../src/agent/cli-agents/antigravity/session.ts";

const HI: Message = { role: "user", content: "hi", timestamp: 0 };

function reply(responseId: string | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "antigravity-cli",
		provider: "antigravity",
		model: "gemini-3.8-flash-low",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...(responseId ? { responseId } : {}),
	};
}

function stampedReply(prompt: string): AssistantMessage {
	const message = reply(undefined);
	message.responseId = toResponseId({ sessionId: "conv-1", prefixHash: hashMessages([HI, message]), promptHash: hashPrompt(prompt) });
	return message;
}

test("stamps round-trip and reject other formats", () => {
	const stamp = { sessionId: "conv-1", prefixHash: "abc", promptHash: "def" };

	assert.deepEqual(parseResponseId(toResponseId(stamp)), stamp);
	assert.equal(parseResponseId("cc1:session:abc"), null);
	assert.equal(parseResponseId("ag1:conv-1:abc"), null);
	assert.equal(parseResponseId(undefined), null);
});

test("an unchanged transcript and prompt resume with only the new input", () => {
	const followUp: Message = { role: "user", content: "why?", timestamp: 0 };

	assert.deepEqual(planSession([HI, stampedReply("p"), followUp], "p"), { kind: "resume", conversationId: "conv-1", input: [followUp] });
});

test("a changed system prompt starts fresh, since agy keeps a conversation's first prompt", () => {
	const plan = planSession([HI, stampedReply("prober"), { role: "user", content: "why?", timestamp: 0 }], "teacher");

	assert.deepEqual(plan, { kind: "fresh", reason: "system prompt changed since the conversation started" });
});

test("finds agy on PATH, then in known dirs; on Windows only on PATH", () => {
	const posix = resolveAgyBinary({ env: { PATH: "/a:/b" }, platform: "darwin", homeDir: "/home/u", isExecutable: (path) => path === "/b/agy" });
	assert.equal(posix, "/b/agy");

	const homebrew = resolveAgyBinary({ env: { PATH: "" }, platform: "darwin", homeDir: "/home/u", isExecutable: (path) => path === "/opt/homebrew/bin/agy" });
	assert.equal(homebrew, "/opt/homebrew/bin/agy");

	const windows = resolveAgyBinary({ env: { PATH: "C:\\tools" }, platform: "win32", homeDir: "C:\\Users\\u", isExecutable: (path) => path === "C:\\tools\\agy.exe" });
	assert.equal(windows, "C:\\tools\\agy.exe");

	assert.equal(resolveAgyBinary({ env: { PATH: "" }, platform: "win32", homeDir: "C:\\Users\\u", isExecutable: () => false }), null);
});
