/**
 * Claude Code session resume decision (src/agent/claude-code/session.ts).
 *
 * A turn resumes the CLI session stamped on the last assistant message only
 * when the transcript up to that message is unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import { hashMessages, parseResponseId, planSession, toResponseId } from "../src/agent/claude-code/session.ts";

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(text: string, fields: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-code-cli",
		provider: "claude-code",
		model: "opus",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...fields,
	};
}

/** An assistant message stamped the way the stream stamps it: hash over everything before it plus itself. */
function stamped(before: Message[], text: string, fields: Partial<AssistantMessage> = {}): AssistantMessage {
	const message = assistant(text, fields);
	message.responseId = toResponseId({ sessionId: "session-1", prefixHash: hashMessages([...before, message]) });
	return message;
}

const HI = user("hi");

test("toResponseId and parseResponseId round-trip; other ids parse to null", () => {
	assert.deepEqual(parseResponseId(toResponseId({ sessionId: "s", prefixHash: "h" })), { sessionId: "s", prefixHash: "h" });
	assert.equal(parseResponseId(undefined), null);
	assert.equal(parseResponseId("msg_123"), null);
	assert.equal(parseResponseId("cc1:s"), null);
});

test("an unchanged transcript plus new input resumes with only the new input", () => {
	const reply = stamped([HI], "hello");
	const followUp = user("why?");

	assert.deepEqual(planSession([HI, reply, followUp]), { kind: "resume", sessionId: "session-1", input: [followUp] });
});

test("tool results after a tool-use message resume as new input", () => {
	const reply = stamped([HI], "reading", { stopReason: "toolUse" });
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "A" }],
		isError: false,
		timestamp: 0,
	};

	assert.deepEqual(planSession([HI, reply, result]), { kind: "resume", sessionId: "session-1", input: [result] });
});

test("ids, usage and timestamps do not count as transcript changes", () => {
	const reply = stamped([HI], "hello");
	const persisted = { ...reply, timestamp: 99, usage: { ...reply.usage, input: 7 } };

	assert.equal(planSession([{ ...HI, timestamp: 5 }, persisted, user("why?")]).kind, "resume");
});

test("an edited or compacted earlier message starts fresh", () => {
	const reply = stamped([HI], "hello");

	const plan = planSession([user("summary of earlier turns"), reply, user("why?")]);
	assert.equal(plan.kind, "fresh");
});

test("a first turn, another provider, an unstamped message or a failed turn starts fresh", () => {
	assert.equal(planSession([HI]).kind, "fresh");
	assert.equal(planSession([HI, assistant("hi", { provider: "openai" }), user("x")]).kind, "fresh");
	assert.equal(planSession([HI, assistant("hi"), user("x")]).kind, "fresh");
	assert.equal(planSession([HI, stamped([HI], "hi", { stopReason: "error" }), user("x")]).kind, "fresh");
	assert.equal(planSession([HI, stamped([HI], "hi", { stopReason: "aborted" }), user("x")]).kind, "fresh");
});

test("nothing after the stamped message starts fresh", () => {
	assert.equal(planSession([HI, stamped([HI], "hello")]).kind, "fresh");
});
