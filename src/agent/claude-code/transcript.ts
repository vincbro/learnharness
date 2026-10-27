import type { ImageContent, Message, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

type ReplayPart = string | ImageContent;

// Earlier turns reach the CLI as one user message. They are wrapped in a record whose tags look
// nothing like a callable tool, because a model shown "[tool call quiz] {...}" next to its own
// prose copies that form and writes tool calls as text instead of making them.
const RECORD_OPEN =
	"<conversation_record>\nThe conversation so far, recorded as context. Every tool call in this record already happened; it is listed for reference only.";
const RECORD_CLOSE =
	"</conversation_record>\n\nThis record is context only. Continue the conversation from its last message. To call a tool now, use the tool itself; never write a tool call as text.";

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function getTaggedParts(open: string, close: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${open}\n${content}\n${close}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	if (images.length === 0) return [`${open}\n${text}\n${close}`];
	return [text ? `${open}\n${text}` : open, ...images, close];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getTaggedParts("<user>", "</user>", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`<assistant>\n${block.text}\n</assistant>`];
				if (block.type === "toolCall") {
					return [`<tool_call_record tool="${block.name}">\n${JSON.stringify(block.arguments)}\n</tool_call_record>`];
				}
				return [];
			});

		case "toolResult": {
			const error = message.isError ? ' error="true"' : "";
			return getTaggedParts(`<tool_result_record tool="${message.toolName}"${error}>`, "</tool_result_record>", message.content);
		}
	}
}

// Tool results whose call was interrupted: the CLI already closed that call, so the result
// arrives as a note in a fresh user message instead of answering it.
function getInterruptedResultParts(message: ToolResultMessage): ReplayPart[] {
	const status = message.isError ? "an error" : "this result";
	const label = `[Your earlier ${message.toolName} call was interrupted before its result reached you. It returned ${status}:]`;

	return getLabelledParts(label, message.content);
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
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

	return toContentBlocks([RECORD_OPEN, ...conversation.flatMap(getReplayParts), RECORD_CLOSE]);
}

/** The new input after a resumed session's last assistant message: user messages as they are,
 *  tool results as interrupted-call notes. */
export function toResumeContent(input: Message[]): ClaudeContentBlock[] {
	return toContentBlocks(
		input.flatMap((message): ReplayPart[] => {
			if (message.role === "toolResult") return getInterruptedResultParts(message);
			if (message.role !== "user") return [];
			return typeof message.content === "string" ? [message.content] : message.content.map((block) => (block.type === "text" ? block.text : block));
		}),
	);
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
