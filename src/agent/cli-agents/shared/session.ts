import { createHash } from "node:crypto";

import type { AssistantMessage, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

// Each CLI assistant message carries the CLI session it came from, plus a hash of the transcript up
// to and including it, in responseId (each provider picks its own stamp format). The next turn
// resumes that session only when the transcript still matches, so the persisted record stays the
// only source of truth.

// Stop reasons a CLI session is known to have recorded cleanly.
const RESUMABLE_STOP_REASONS = new Set<AssistantMessage["stopReason"]>(["stop", "toolUse", "length"]);

export type SessionStamp = { sessionId: string; prefixHash: string };

export type ResumePlan<Stamp extends SessionStamp> =
	| { kind: "resume"; stamp: Stamp; input: Message[] }
	| { kind: "fresh"; reason: string };

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

/** Resume the session stamped on the last assistant message when it came from this provider, ended
 *  cleanly and the transcript up to it is unchanged; otherwise start fresh, saying why. */
export function planResume<Stamp extends SessionStamp>(
	messages: Message[],
	provider: string,
	parseStamp: (responseId: string | undefined) => Stamp | null,
): ResumePlan<Stamp> {
	const anchorIndex = messages.findLastIndex((message) => message.role === "assistant");
	const anchor = messages[anchorIndex];
	if (anchor?.role !== "assistant") return { kind: "fresh", reason: "no earlier assistant message" };
	if (anchor.provider !== provider) return { kind: "fresh", reason: "last assistant message is from another provider" };

	const stamp = parseStamp(anchor.responseId);
	if (!stamp) return { kind: "fresh", reason: "last assistant message has no session stamp" };
	if (!RESUMABLE_STOP_REASONS.has(anchor.stopReason)) return { kind: "fresh", reason: `last turn ended with ${anchor.stopReason}` };

	if (hashMessages(messages.slice(0, anchorIndex + 1)) !== stamp.prefixHash) {
		return { kind: "fresh", reason: "transcript changed since the session was recorded" };
	}

	// System messages carry no turn content; the current system prompt is passed on every resume.
	const input = messages.slice(anchorIndex + 1).filter((message) => message.role !== "system");
	if (input.length === 0) return { kind: "fresh", reason: "nothing new to send" };

	return { kind: "resume", stamp, input };
}
