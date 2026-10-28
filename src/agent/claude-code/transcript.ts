import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { toRecordParts, toResumeParts, type ReplayPart } from "../cli-agents/shared/transcript.ts";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function toContentBlocks(parts: ReplayPart[]): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toUserContent(conversation: Message[]): ClaudeContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);

	return toContentBlocks(toRecordParts(conversation));
}

/** The new input after a resumed session's last assistant message: user messages as they are,
 *  tool results as interrupted-call notes. */
export function toResumeContent(input: Message[]): ClaudeContentBlock[] {
	return toContentBlocks(toResumeParts(input));
}

export function toClaudeInput(messages: Message[]): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		userContent: toUserContent(conversation),
	};
}

export function toStreamJsonLine(content: ClaudeContentBlock[]): string {
	return JSON.stringify({ type: "user", message: { role: "user", content } });
}
