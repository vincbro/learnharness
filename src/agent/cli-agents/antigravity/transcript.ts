import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { toRecordParts, toResumeParts, type ReplayPart } from "../shared/transcript.ts";

export type AgyInput = {
	systemPrompt: string;
	tools: Tool[];
	text: string;
};

// agy's stream-json input rejects image blocks, so each image becomes pi's own note for
// models without image input.
const IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

function toText(parts: ReplayPart[]): string {
	return parts.map((part) => (typeof part === "string" ? part : IMAGE_PLACEHOLDER)).join("\n\n");
}

function toUnlabelledText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;

	return toText(content.map((block) => (block.type === "text" ? block.text : block)));
}

function toUserText(conversation: Message[]): string {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledText(first.content);

	return toText(toRecordParts(conversation));
}

/** The new input after a resumed conversation's last assistant message. */
export function toResumeText(input: Message[]): string {
	return toText(toResumeParts(input));
}

export function toAgyInput(messages: Message[]): AgyInput {
	const conversation = messages.filter((message) => message.role !== "system");

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		text: toUserText(conversation),
	};
}

export function toStdinLine(text: string): string {
	return JSON.stringify({ event: "user", message: { content: text } });
}
