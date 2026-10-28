import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
	type StreamFunction,
	type TextContent,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../shared/live-processes.ts";
import { BRIDGE_SERVER_NAME, createMcpBridge, type McpBridge, type PendingToolCall } from "../shared/tool-bridge.ts";
import { getAgyBinary } from "./binary.ts";
import { AntigravityError } from "./constants.ts";
import { parseAgyLine, type AgyEvent, type AgyUsage } from "./events.ts";
import { hashMessages, hashPrompt, planSession, toResponseId } from "./session.ts";
import { toAgyInput, toResumeText, toStdinLine } from "./transcript.ts";
import { AGENT_NAME, createWorkspace, removeWorkspace } from "./workspace.ts";

type RunAgyOptions = { cwd: string; env: NodeJS.ProcessEnv };

export type RunAgy = (args: string[], options: RunAgyOptions) => ChildProcessWithoutNullStreams | null;

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";
const NOT_SIGNED_IN_ERROR = "authentication failed or timed out";
const SUCCESS_STATUS = "SUCCESS";

/** agy reports calls one step at a time; a turn ends on its tool calls once no further call has
 *  shown up for this long and every one of them has reached the bridge. */
export const TOOL_SETTLE_MS = 250;

/** Test seam (live-processes' liveProcessIdleTimeoutMs idiom). */
export const toolSettleMs = { current: TOOL_SETTLE_MS };

type AgyArgsInput = { model: string; conversationId?: string };

export function toAgyArgs(input: AgyArgsInput): string[] {
	return [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--agent",
		AGENT_NAME,
		"--model",
		input.model,
		// Print mode can't ask for permission and denies MCP calls without an allow rule in the
		// user's global settings. The agent hides agy's built-in tools, so only pi's tools remain
		// (owner, 2026-10-28).
		"--dangerously-skip-permissions",
		"--disable-slash-commands",
		...(input.conversationId ? ["--conversation", input.conversationId] : []),
		// stream-json input ignores the prompt, but -p always takes a value.
		"-p",
		"",
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

function getResultErrorMessage(error: string | undefined, status: string): string {
	if (error === NOT_SIGNED_IN_ERROR) return AntigravityError.NotSignedIn;
	return error ?? `agy CLI ended with status ${status}`;
}

function toToolCallId(): string {
	return `agy_${randomUUID().replaceAll("-", "")}`;
}

class AgyTurn {
	private readonly output: AssistantMessage;
	/** Text block per agent_response step, until that step is done. */
	private readonly openText = new Map<number, number>();
	/** pi tool calls by step, held back until the turn ends on them. */
	private readonly pendingCalls = new Map<number, ToolCall>();
	started = false;
	finished = false;
	/** The agy conversation this turn runs in, and the system prompt it was created with; both are
	 *  stamped on the finished message for the next turn. */
	conversationId: string | undefined;
	promptHash: string | undefined;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
		private readonly messages: Message[],
	) {
		this.output = createOutput(model);
	}

	get pendingCallCount(): number {
		return this.pendingCalls.size;
	}

	handle(event: AgyEvent): void {
		if (this.finished) return;

		switch (event.type) {
			case "response":
				this.handleResponse(event.step, event.text, event.done, event.usage);
				return;

			case "mcpTool":
				this.handleToolStep(event.step, event.state, event.tool, event.arguments, event.server);
				return;

			case "result":
				if (event.status === SUCCESS_STATUS) this.finish("stop");
				else this.fail(getResultErrorMessage(event.error, event.status), "error");
				return;

			case "init":
				return;
		}
	}

	getToolCalls(): ToolCall[] {
		if (!this.finished || this.output.stopReason !== "toolUse") return [];

		return this.output.content.filter((block) => block.type === "toolCall");
	}

	/** Ends the message on the calls agy is now waiting on. */
	finishWithToolCalls(): void {
		if (this.finished || this.pendingCalls.size === 0) return;

		this.start();
		this.closeOpenText();

		for (const toolCall of this.pendingCalls.values()) {
			const contentIndex = this.output.content.length;
			this.output.content.push(toolCall);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
		}

		this.pendingCalls.clear();
		this.finish("toolUse");
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

	private handleResponse(step: number, text: string, done: boolean, usage: AgyUsage | undefined): void {
		if (usage) this.addUsage(usage);

		if (text) {
			this.start();

			let contentIndex = this.openText.get(step);
			if (contentIndex === undefined) {
				contentIndex = this.output.content.length;
				this.openText.set(step, contentIndex);
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
			}

			const block = this.output.content[contentIndex] as TextContent;
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
		}

		if (done) this.closeText(step);
	}

	private handleToolStep(step: number, state: string, tool: string, args: ToolCall["arguments"], server: string): void {
		if (server !== BRIDGE_SERVER_NAME) return;

		if (state === "ACTIVE") {
			if (!this.pendingCalls.has(step)) this.pendingCalls.set(step, { type: "toolCall", id: toToolCallId(), name: tool, arguments: args });
			return;
		}

		// Settled before the turn ended on it (e.g. agy rejected the call itself): agy already
		// gave the model its outcome, so pi never runs it.
		this.pendingCalls.delete(step);
	}

	private closeText(step: number): void {
		const contentIndex = this.openText.get(step);
		if (contentIndex === undefined) return;

		this.openText.delete(step);
		const block = this.output.content[contentIndex] as TextContent;
		this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
	}

	private closeOpenText(): void {
		for (const step of [...this.openText.keys()]) this.closeText(step);
	}

	// The context size is the latest model call's input; output adds up over the message's calls.
	private addUsage(usage: AgyUsage): void {
		const total = this.output.usage;
		total.input = usage.input;
		total.cacheRead = usage.cacheRead;
		total.output += usage.output;
		total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
	}

	private finish(stopReason: "stop" | "toolUse"): void {
		if (this.finished) return;

		this.start();
		this.closeOpenText();
		this.output.stopReason = stopReason;

		if (this.conversationId && this.promptHash) {
			const prefixHash = hashMessages([...this.messages, this.output]);
			this.output.responseId = toResponseId({ sessionId: this.conversationId, prefixHash, promptHash: this.promptHash });
		}

		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

type UnansweredToolCall = { toolCall: ToolCall; result: ToolResultMessage };

function isSameToolCall(toolCall: ToolCall, call: PendingToolCall): boolean {
	return toolCall.name === call.name && isDeepStrictEqual(toolCall.arguments, call.arguments);
}

class AgyProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private signal: AbortSignal | undefined;
	private settleTimer: NodeJS.Timeout | undefined;
	/** Set on a resume run: starts a new conversation if agy can't resume this one. */
	resumeFallback: (() => void) | undefined;
	private handedOff = false;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: McpBridge,
		private readonly workspace: string,
		private turn: AgyTurn,
		/** The conversation a resume run asked for. */
		private readonly expectedConversationId: string | undefined,
	) {}

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});

		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));

		// Closing stdin ends the session once this turn's result is out.
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));
		this.child.stdin.end(`${stdinLine}\n`);

		createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));

		this.setSignal(signal);
	}

	continueTurn(turn: AgyTurn, toolResults: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);

		const unanswered = this.turn.getToolCalls().flatMap((toolCall) => {
			const result = toolResults.find((toolResult) => toolResult.toolCallId === toolCall.id);
			return result ? [{ toolCall, result }] : [];
		});

		turn.conversationId = this.turn.conversationId;
		turn.promptHash = this.turn.promptHash;
		this.turn = turn;
		this.setSignal(signal);

		this.answerToolCalls(unanswered);
	}

	kill(): void {
		clearTimeout(this.settleTimer);
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
		const event = parseAgyLine(line);
		if (!event) return;

		if (event.type === "init") {
			this.handleInit(event.conversationId);
			return;
		}

		if (this.handedOff) return;

		// A call agy makes after the turn ended on its calls would wait on pi forever.
		if (this.turn.finished) {
			if (event.type === "mcpTool" && event.state === "ACTIVE" && event.server === BRIDGE_SERVER_NAME) this.kill();
			return;
		}

		this.turn.handle(event);
		if (!this.turn.finished && this.turn.pendingCallCount > 0) this.scheduleToolSettle();
	}

	private handleInit(conversationId: string): void {
		// agy starts a new conversation, with only a warning, when it can't find the one asked for.
		if (this.expectedConversationId && conversationId !== this.expectedConversationId && this.resumeFallback) {
			const fallback = this.resumeFallback;
			this.resumeFallback = undefined;
			this.handedOff = true;
			console.info("agy CLI could not resume the conversation, starting a new one");
			this.kill();
			fallback();
			return;
		}

		this.turn.conversationId = conversationId;
	}

	private scheduleToolSettle(): void {
		clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => void this.settleToolCalls(), toolSettleMs.current);
	}

	private async settleToolCalls(): Promise<void> {
		const turn = this.turn;
		const count = turn.pendingCallCount;
		if (turn.finished || count === 0) return;

		// Rejects only once the bridge has closed, which means the process is already gone.
		const reached = await this.bridge.waitForToolCalls(count).catch(() => null);
		if (!reached || turn !== this.turn || turn.finished) return;

		// More calls showed up (or some settled) meanwhile: wait for those too.
		if (turn.pendingCallCount !== count) {
			this.scheduleToolSettle();
			return;
		}

		turn.finishWithToolCalls();
		this.toolCallIds = turn.getToolCalls().map((toolCall) => toolCall.id);
		addLiveProcess(this);
	}

	// Every call reached the bridge before the turn ended on it, so each result can answer its
	// held call right away.
	private answerToolCalls(unanswered: UnansweredToolCall[]): void {
		const pending = this.bridge.getPendingToolCalls();

		for (const { toolCall, result } of unanswered) {
			const index = pending.findIndex((call) => isSameToolCall(toolCall, call));
			const fallbackIndex = index >= 0 ? index : pending.findIndex((call) => call.name === toolCall.name);
			const call = pending[fallbackIndex];
			if (!call) continue;

			this.bridge.resolveToolCall(call, result);
			pending.splice(fallbackIndex, 1);
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;

		this.closed = true;
		clearTimeout(this.settleTimer);
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);

		if (this.stderr.trim() && !this.handedOff) console.error("agy CLI stderr:", this.stderr.trim());

		if (!this.handedOff) this.turn.fail(message, "error");

		this.bridge
			.close()
			.then(() => removeWorkspace(this.workspace))
			.catch((error: unknown) => console.error("agy CLI cleanup failed:", error));
	}
}

function continueLiveProcess(turn: AgyTurn, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;

	const toolCallIds = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const process = getLiveProcess(toolCallIds);
	if (!(process instanceof AgyProcess)) return false;

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

// agy only bills a Gemini API key when its own settings opt into it, but a key saved on the Keys
// page must never be the one a turn runs on.
const API_CREDENTIAL_ENV_NAMES = ["GEMINI_API_KEY"];

function toAgyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const agyEnv: NodeJS.ProcessEnv = { ...env };

	for (const name of API_CREDENTIAL_ENV_NAMES) delete agyEnv[name];

	return agyEnv;
}

async function startProcess(
	runAgy: RunAgy,
	turn: AgyTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	forceFresh = false,
): Promise<void> {
	const input = toAgyInput(context.messages);
	const plan = forceFresh ? { kind: "fresh" as const, reason: "resume failed" } : planSession(context.messages, input.systemPrompt);
	if (plan.kind === "fresh" && context.messages.some((message) => message.role === "assistant")) {
		console.info("agy CLI starting a new conversation with a replay:", plan.reason);
	}

	const conversationId = plan.kind === "resume" ? plan.conversationId : undefined;
	// A resumed conversation keeps its first prompt, which planSession checked is this one.
	turn.promptHash = hashPrompt(input.systemPrompt);
	const text = plan.kind === "resume" ? toResumeText(plan.input) : input.text;

	const bridge = await createMcpBridge(input.tools);
	let workspace: string;
	try {
		workspace = await createWorkspace(input.systemPrompt, bridge);
	} catch (error) {
		await bridge.close();
		throw error;
	}

	const cleanUp = async () => {
		await bridge.close();
		await removeWorkspace(workspace);
	};

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = runAgy(toAgyArgs({ model: model.id, conversationId }), { cwd: workspace, env: toAgyEnv(process.env) });
	} catch (error) {
		await cleanUp();
		throw error;
	}

	if (!child) {
		turn.fail(AntigravityError.CliNotFound, "error");
		await cleanUp();
		return;
	}

	const agy = new AgyProcess(child, bridge, workspace, turn, conversationId);
	if (plan.kind === "resume") {
		agy.resumeFallback = () => {
			startProcess(runAgy, turn, model, context, options, true).catch((error: unknown) => {
				console.error("agy CLI turn failed:", error);
				turn.fail(START_FAILED_MESSAGE, "error");
			});
		};
	}

	agy.start(toStdinLine(text), options?.signal);
}

export function createAntigravityStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AgyTurn(stream, model, context.messages);

		if (continueLiveProcess(turn, context.messages, options?.signal)) return stream;

		startProcess(runAgy, turn, model, context, options).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(START_FAILED_MESSAGE, "error");
		});

		return stream;
	};
}

function spawnAgy(args: string[], options: RunAgyOptions): ChildProcessWithoutNullStreams | null {
	const binary = getAgyBinary();

	return binary ? spawn(binary, args, { ...options, stdio: "pipe" }) : null;
}

export const streamAntigravity = createAntigravityStreamFunction(spawnAgy);
