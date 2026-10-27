import { createHash } from "node:crypto";

import type { AssistantMessage, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

import { CLAUDE_CODE_PROVIDER } from "./constants.ts";

// Each claude-code assistant message carries the CLI session it came from, plus a hash of the
// transcript up to and including it, in responseId. The next turn resumes that session only when
// the transcript still matches, so the persisted record stays the only source of truth.
const STAMP_PREFIX = "cc1";

// Stop reasons the CLI session is known to have recorded cleanly.
const RESUMABLE_STOP_REASONS = new Set<AssistantMessage["stopReason"]>(["stop", "toolUse", "length"]);

export type SessionStamp = { sessionId: string; prefixHash: string };

export type SessionPlan =
	| { kind: "resume"; sessionId: string; input: Message[] }
	| { kind: "fresh"; reason: string };

export function toResponseId(stamp: SessionStamp): string {
	return `${STAMP_PREFIX}:${stamp.sessionId}:${stamp.prefixHash}`;
}

export function parseResponseId(responseId: string | undefined): SessionStamp | null {
	const [prefix, sessionId, prefixHash, ...rest] = (responseId ?? "").split(":");
	if (prefix !== STAMP_PREFIX || !sessionId || !prefixHash || rest.length > 0) return null;

	return { sessionId, prefixHash };
}

function hashImage(image: ImageContent): string {
	return createHash("sha256").update(image.data).digest("hex");
}

function normalizeContent(content: string | (TextContent | ImageContent)[]): unknown[] {
	if (typeof content === "string") return [["text", content]];

	return content.map((block) => (block.type === "text" ? ["text", block.text] : ["image", block.mimeType, hashImage(block)]));
}

// Only what the model saw: ids, usage, timestamps and app-side details are left out.
function normalizeMessage(message: Message): unknown {
	switch (message.role) {
		case "user":
			return ["user", normalizeContent(message.content)];

		case "assistant":
			return [
				"assistant",
				message.content.map((block) => {
					if (block.type === "text") return ["text", block.text];
					if (block.type === "thinking") return ["thinking", block.thinking];
					return ["toolCall", block.id, block.name, block.arguments];
				}),
			];

		case "toolResult":
			return ["toolResult", message.toolCallId, message.toolName, message.isError, normalizeContent(message.content)];

		default:
			return ["other"];
	}
}

export function hashMessages(messages: Message[]): string {
	return createHash("sha256").update(JSON.stringify(messages.map(normalizeMessage))).digest("hex");
}

export function planSession(messages: Message[]): SessionPlan {
	const anchorIndex = messages.findLastIndex((message) => message.role === "assistant");
	const anchor = messages[anchorIndex];
	if (anchor?.role !== "assistant") return { kind: "fresh", reason: "no earlier assistant message" };
	if (anchor.provider !== CLAUDE_CODE_PROVIDER) return { kind: "fresh", reason: "last assistant message is from another provider" };

	const stamp = parseResponseId(anchor.responseId);
	if (!stamp) return { kind: "fresh", reason: "last assistant message has no session stamp" };
	if (!RESUMABLE_STOP_REASONS.has(anchor.stopReason)) return { kind: "fresh", reason: `last turn ended with ${anchor.stopReason}` };

	if (hashMessages(messages.slice(0, anchorIndex + 1)) !== stamp.prefixHash) {
		return { kind: "fresh", reason: "transcript changed since the session was recorded" };
	}

	// System messages carry no turn content; the current system prompt is passed on every resume.
	const input = messages.slice(anchorIndex + 1).filter((message) => message.role !== "system");
	if (input.length === 0) return { kind: "fresh", reason: "nothing new to send" };

	return { kind: "resume", sessionId: stamp.sessionId, input };
}
