import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
	validateToolCall,
} from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";

import { getClaudeBinary } from "./binary.ts";
import { parseCliLine, type CliBlock, type CliEvent, type CliUsage } from "./cli-events.ts";
import { ClaudeCodeError } from "./constants.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { learnModelLimits } from "./provider.ts";
import { hashMessages, planSession, toResponseId } from "./session.ts";
import { createToolBridge, toolNameFromMcp, type PendingToolCall, type ToolBridge } from "./tool-bridge.ts";
import { toClaudeInput, toResumeContent, toStreamJsonLine } from "./transcript.ts";

type RunClaudeOptions = { cwd: string; env: NodeJS.ProcessEnv };

export type RunClaude = (args: string[], options: RunClaudeOptions) => ChildProcessWithoutNullStreams | null;

// A held MCP call lasts until pi calls back with the tool result, which for a question tool is
// whenever the learner answers; this must outlast the live-process idle timeout so the CLI never
// times out first.
const MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

const PRIVATE_FILE_MODE = 0o600;

const EFFORTS: Record<ThinkingLevel, AnthropicEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	pause_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	tool_use: "toolUse",
	refusal: "error",
};

const REFUSAL_MESSAGE = "The model refused to complete the request";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "claude CLI failed to start";
const NO_STOP_REASON_MESSAGE = "claude CLI ended the message without a stop reason";
const NOT_SIGNED_IN_ERROR = "authentication_failed";

export function toEffort(level: ThinkingLevel | undefined): AnthropicEffort {
	return level ? EFFORTS[level] : "medium";
}

/** A new CLI session gets the id we pick; a later turn resumes it by that id. */
export type ClaudeSessionArgs = { kind: "new"; id: string } | { kind: "resume"; id: string };

type ClaudeArgsInput = {
	session: ClaudeSessionArgs;
	model: string;
	effort: AnthropicEffort;
	systemPromptFile: string;
	mcpConfigFile: string;
	allowedTools: string[];
};

export function toClaudeArgs(input: ClaudeArgsInput): string[] {
	return [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		input.model,
		"--effort",
		input.effort,
		"--system-prompt-file",
		input.systemPromptFile,
		// Without this a resumed session keeps its first system prompt, so the prober→teacher switch
		// and prompt edits would never reach it.
		"--system-prompt-snapshot",
		"off",
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		input.mcpConfigFile,
		"--setting-sources",
		"",
		"--disable-slash-commands",
		input.session.kind === "new" ? "--session-id" : "--resume",
		input.session.id,
		"--permission-prompts",
		"none",
		...(input.allowedTools.length > 0 ? ["--allowedTools", input.allowedTools.join(",")] : []),
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function getAssistantErrorMessage(error: string, text: string): string {
	return error === NOT_SIGNED_IN_ERROR ? ClaudeCodeError.NotSignedIn : text || error;
}

class ClaudeTurn {
	private readonly output: AssistantMessage;
	private readonly contentIndexes = new Map<number, number>();
	private readonly partialJson = new Map<number, string>();
	started = false;
	finished = false;
	/** The CLI session this turn runs in; stamped on the finished message for the next turn. */
	sessionId: string | undefined;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
		private readonly messages: Message[],
	) {
		this.output = createOutput(model);
	}

	get responseModel(): string | undefined {
		return this.output.responseModel;
	}

	handle(event: CliEvent): void {
		if (this.finished) return;

		switch (event.type) {
			case "messageStart":
				if (event.model) this.output.responseModel = event.model;
				this.updateUsage(event.usage);
				this.start();
				return;

			case "blockStart":
				this.startBlock(event.index, event.block);
				return;

			case "textDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "text") return;

				block.text += event.text;
				this.stream.push({ type: "text_delta", contentIndex, delta: event.text, partial: this.output });
				return;
			}

			case "thinkingDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "thinking") return;

				block.thinking += event.thinking;
				this.stream.push({ type: "thinking_delta", contentIndex, delta: event.thinking, partial: this.output });
				return;
			}

			case "toolInputDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "toolCall") return;

				const partialJson = (this.partialJson.get(event.index) ?? "") + event.partialJson;
				this.partialJson.set(event.index, partialJson);
				block.arguments = parseStreamingJson(partialJson);
				this.stream.push({ type: "toolcall_delta", contentIndex, delta: event.partialJson, partial: this.output });
				return;
			}

			case "blockStop":
				this.stopBlock(event.index);
				return;

			case "messageDelta":
				this.updateUsage(event.usage);
				if (event.stopReason) this.setStopReason(event.stopReason);
				return;

			case "messageStop":
				this.finish();
				return;

			case "assistantError":
				this.fail(getAssistantErrorMessage(event.error, event.text), "error");
				return;

			case "resultError":
				this.fail(event.text, "error");
				return;

			case "result":
				return;
		}
	}

	getToolCalls(): ToolCall[] {
		if (!this.finished || this.output.stopReason !== "toolUse") return [];

		return this.output.content.filter((block) => block.type === "toolCall");
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;

		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;

		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private startBlock(index: number, block: CliBlock): void {
		const contentIndex = this.output.content.length;
		this.contentIndexes.set(index, contentIndex);

		switch (block.type) {
			case "text":
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
				return;

			case "thinking":
				this.output.content.push({ type: "thinking", thinking: "" });
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				return;

			case "toolUse":
				this.output.content.push({ type: "toolCall", id: block.id, name: toolNameFromMcp(block.name), arguments: {} });
				this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
				return;
		}
	}

	private getBlock(index: number): { contentIndex: number; block: AssistantMessage["content"][number] } | null {
		const contentIndex = this.contentIndexes.get(index);
		if (contentIndex === undefined) return null;

		const block = this.output.content[contentIndex];
		return block ? { contentIndex, block } : null;
	}

	private stopBlock(index: number): void {
		const found = this.getBlock(index);
		if (!found) return;

		const { contentIndex, block } = found;
		this.contentIndexes.delete(index);

		switch (block.type) {
			case "text":
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
				return;

			case "thinking":
				this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
				return;

			case "toolCall":
				Object.assign(block, parseToolCallArguments(this.partialJson.get(index) ?? ""));
				this.partialJson.delete(index);
				this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block satisfies ToolCall, partial: this.output });
				return;
		}
	}

	private updateUsage(usage: CliUsage): void {
		Object.assign(this.output.usage, usage);

		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	private setStopReason(stopReason: string): void {
		const mapped = STOP_REASONS[stopReason];

		if (!mapped) {
			this.output.stopReason = "error";
			this.output.errorMessage = `Unhandled stop reason: ${stopReason}`;
			return;
		}

		this.output.stopReason = mapped;
	}

	private finish(): void {
		const { stopReason } = this.output;

		if (stopReason === "error") {
			this.fail(this.output.errorMessage ?? REFUSAL_MESSAGE, "error");
			return;
		}

		if (stopReason === "pending" || stopReason === "aborted") {
			this.fail(this.output.errorMessage ?? NO_STOP_REASON_MESSAGE, "error");
			return;
		}

		if (this.sessionId) {
			const prefixHash = hashMessages([...this.messages, this.output]);
			this.output.responseId = toResponseId({ sessionId: this.sessionId, prefixHash });
		}

		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

type TurnFiles = { cwd: string; privateDir: string; systemPromptFile: string; mcpConfigFile: string };

// One empty working directory for every run: the CLI files its sessions under the cwd, so a fixed
// one keeps them in a single folder of ~/.claude/projects.
const SESSION_CWD = join(tmpdir(), "learnharness-claude-code");

async function createTurnFiles(systemPrompt: string, mcpConfig: string): Promise<TurnFiles> {
	const cwd = SESSION_CWD;
	await mkdir(cwd, { recursive: true });
	const privateDir = await mkdtemp(join(tmpdir(), "claude-code-private-"));

	const systemPromptFile = join(privateDir, "system-prompt.md");
	const mcpConfigFile = join(privateDir, "mcp.json");

	await writeFile(systemPromptFile, systemPrompt, { mode: PRIVATE_FILE_MODE });
	await writeFile(mcpConfigFile, mcpConfig, { mode: PRIVATE_FILE_MODE });

	return { cwd, privateDir, systemPromptFile, mcpConfigFile };
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await bridge.close();
	await rm(files.privateDir, { recursive: true, force: true });
}

type UnansweredToolCall = { toolCall: ToolCall; result: ToolResultMessage };

// The CLI answers calls to undeclared tools or with invalid arguments itself, without reaching the bridge.
function isValidToolCall(tools: Tool[], toolCall: ToolCall): boolean {
	try {
		validateToolCall(tools, toolCall);
		return true;
	} catch {
		return false;
	}
}

function isSameToolCall(toolCall: ToolCall, call: PendingToolCall): boolean {
	return toolCall.name === call.name && isDeepStrictEqual(toolCall.arguments, call.arguments);
}

class ClaudeProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private signal: AbortSignal | undefined;
	/** Set on a resume run: starts a fresh session if the CLI can't resume this one. */
	resumeFallback: (() => void) | undefined;
	private handedOff = false;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private readonly tools: Tool[],
		private turn: ClaudeTurn,
		private readonly sessionId: string,
		private readonly modelId: string,
	) {
		turn.sessionId = sessionId;
	}

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`claude CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("claude CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});

		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));

		this.child.stdin.on("error", (error) => console.error("claude CLI stdin closed early:", error));
		this.child.stdin.end(`${stdinLine}\n`);

		createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));

		this.setSignal(signal);
	}

	continueTurn(turn: ClaudeTurn, toolResults: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);

		const unanswered = this.turn.getToolCalls().flatMap((toolCall) => {
			const result = toolResults.find((toolResult) => toolResult.toolCallId === toolCall.id);
			return result ? [{ toolCall, result }] : [];
		});

		this.turn = turn;
		turn.sessionId = this.sessionId;
		this.setSignal(signal);

		this.answerToolCalls(turn, unanswered).catch((error: unknown) => {
			console.error("claude CLI tool results failed:", error);
			turn.fail(START_FAILED_MESSAGE, "error");
			this.kill();
		});
	}

	kill(): void {
		removeLiveProcess(this);
		this.child.kill();
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });

		if (signal?.aborted) this.abort();
	}

	private handleLine(line: string): void {
		const event = parseCliLine(line);
		if (!event) return;

		if (event.type === "result") {
			this.learnLimits(event.modelLimits);
			return;
		}

		// A missing or broken session fails before any output; the turn retries in a fresh one.
		if (event.type === "resultError" && !this.turn.started && this.resumeFallback) {
			const fallback = this.resumeFallback;
			this.resumeFallback = undefined;
			this.handedOff = true;
			console.info("claude CLI could not resume the session, starting a new one:", event.text);
			this.kill();
			fallback();
			return;
		}

		// Output after a finished message means the CLI moved on without waiting for our tool results.
		if (this.turn.finished) {
			this.kill();
			return;
		}

		this.turn.handle(event);
		if (!this.turn.finished) return;

		const toolCalls = this.turn.getToolCalls();
		this.toolCallIds = toolCalls.map((toolCall) => toolCall.id);

		const reachesBridge = toolCalls.length > 0 && toolCalls.every((toolCall) => isValidToolCall(this.tools, toolCall));
		if (!reachesBridge) {
			this.kill();
			return;
		}

		addLiveProcess(this);
	}

	private learnLimits(modelLimits: Record<string, { contextWindow: number; maxOutputTokens: number }>): void {
		const responseModel = this.turn.responseModel;
		const limits = responseModel ? modelLimits[responseModel] : undefined;
		if (!limits) return;

		learnModelLimits(this.modelId, { contextWindow: limits.contextWindow, maxTokens: limits.maxOutputTokens });
	}

	private async answerToolCalls(turn: ClaudeTurn, unanswered: UnansweredToolCall[]): Promise<void> {
		while (unanswered.length > 0 && !turn.started) {
			const pending = this.bridge.getPendingToolCalls();
			let answered = false;

			for (const call of pending) {
				const index = unanswered.findIndex(({ toolCall }) => isSameToolCall(toolCall, call));
				const match = unanswered[index];
				if (!match) continue;

				this.bridge.resolveToolCall(call, match.result);
				unanswered.splice(index, 1);
				answered = true;
			}

			if (answered) continue;

			// Rejects only once the bridge has closed, which means the process is already gone.
			const next = await this.bridge.waitForToolCalls(pending.length + 1).catch(() => null);
			if (!next) return;
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;

		this.closed = true;
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);

		if (this.stderr.trim() && !this.handedOff) console.error("claude CLI stderr:", this.stderr.trim());

		if (!this.handedOff) this.turn.fail(message, "error");

		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("claude CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(turn: ClaudeTurn, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;

	const toolCallIds = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const process = getLiveProcess(toolCallIds);
	if (!(process instanceof ClaudeProcess)) return false;

	const trailing = messages.slice(assistantIndex + 1);
	const toolResults = trailing.filter((message) => message.role === "toolResult");

	const onlyToolResults = toolResults.length === trailing.length;
	const answersEveryCall = toolCallIds.every((id) => toolResults.some((toolResult) => toolResult.toolCallId === id));

	if (!onlyToolResults || !answersEveryCall) {
		process.kill();
		return false;
	}

	process.continueTurn(turn, toolResults, signal);
	return true;
}

// Either one takes precedence over the logged-in subscription, so a key saved on the Keys page
// would bill turns to the API account.
const API_CREDENTIAL_ENV_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

function toClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const claudeEnv: NodeJS.ProcessEnv = { ...env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) };

	for (const name of API_CREDENTIAL_ENV_NAMES) delete claudeEnv[name];

	return claudeEnv;
}

async function startProcess(
	runClaude: RunClaude,
	turn: ClaudeTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	forceFresh = false,
): Promise<void> {
	const input = toClaudeInput(context.messages);
	const plan = forceFresh ? { kind: "fresh" as const, reason: "resume failed" } : planSession(context.messages);
	if (plan.kind === "fresh" && context.messages.some((message) => message.role === "assistant")) {
		console.info("claude CLI starting a new session with a replay:", plan.reason);
	}

	const session: ClaudeSessionArgs = plan.kind === "resume" ? { kind: "resume", id: plan.sessionId } : { kind: "new", id: randomUUID() };
	const userContent = plan.kind === "resume" ? toResumeContent(plan.input) : input.userContent;

	const bridge = await createToolBridge(input.tools);
	const files = await createTurnFiles(input.systemPrompt, bridge.mcpConfig);

	let child: ChildProcessWithoutNullStreams | null;
	try {
		const args = toClaudeArgs({
			session,
			model: model.id,
			effort: toEffort(options?.reasoning),
			systemPromptFile: files.systemPromptFile,
			mcpConfigFile: files.mcpConfigFile,
			allowedTools: bridge.allowedTools,
		});
		child = runClaude(args, { cwd: files.cwd, env: toClaudeEnv(process.env) });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(ClaudeCodeError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	const claude = new ClaudeProcess(child, bridge, files, input.tools, turn, session.id, model.id);
	if (plan.kind === "resume") {
		claude.resumeFallback = () => {
			startProcess(runClaude, turn, model, context, options, true).catch((error: unknown) => {
				console.error("claude CLI turn failed:", error);
				turn.fail(START_FAILED_MESSAGE, "error");
			});
		};
	}

	claude.start(toStreamJsonLine(userContent), options?.signal);
}

export function createClaudeCodeStreamFunction(runClaude: RunClaude): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new ClaudeTurn(stream, model, context.messages);

		if (continueLiveProcess(turn, context.messages, options?.signal)) return stream;

		startProcess(runClaude, turn, model, context, options).catch((error: unknown) => {
			console.error("claude CLI turn failed:", error);
			turn.fail(START_FAILED_MESSAGE, "error");
		});

		return stream;
	};
}

function spawnClaude(args: string[], options: RunClaudeOptions): ChildProcessWithoutNullStreams | null {
	const binary = getClaudeBinary();

	return binary ? spawn(binary, args, { ...options, stdio: "pipe" }) : null;
}

export const streamClaudeCode = createClaudeCodeStreamFunction(spawnClaude);
