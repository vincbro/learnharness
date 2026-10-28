import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction, type ThinkingLevel } from "@earendil-works/pi-ai";

import type { CliModelEntry } from "../cli-agents/shared/discovery.ts";
import { CLAUDE_CODE_API, CLAUDE_CODE_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: CLAUDE_CODE_API,
	provider: CLAUDE_CODE_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	// Billed to the user's Claude subscription, not per token.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// What the CLI reports for opus, sonnet and haiku (checked 2026-10-27); learnModelLimits
	// replaces them with each run's reported values.
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name" | "reasoning" | "thinkingLevelMap">;

const CLI_EFFORT_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The connected account's models. Filled from the saved connection and replaced in place on
 *  connect and refresh: the provider reads this array on every lookup. Anchored on globalThis
 *  (the chatgpt-bridge idiom) so every route bundle's copy of this module shares one list. */
export const CLAUDE_CODE_MODELS: Model<Api>[] = ((globalThis as Record<symbol, Model<Api>[] | undefined>)[Symbol.for("learnharness.claudeCodeModels")] ??= []);

/** The CLI has no thinking-off switch; each model takes the effort levels it reports, and its
 *  lowest one is the floor. */
export function toClaudeCodeModel(entry: CliModelEntry): Model<Api> {
	const efforts = new Set(entry.efforts ?? []);
	const levels = CLI_EFFORT_LEVELS.filter((level) => efforts.has(level));
	const thinkingLevelMap = Object.fromEntries(CLI_EFFORT_LEVELS.map((level) => [level, levels.includes(level) ? level : null]));

	return {
		...SHARED_MODEL_FIELDS,
		id: entry.id,
		name: entry.name,
		reasoning: levels.length > 0,
		thinkingLevelMap: { off: null, minimal: null, ...thinkingLevelMap },
	};
}

export function setClaudeCodeModels(entries: CliModelEntry[]): void {
	CLAUDE_CODE_MODELS.splice(0, CLAUDE_CODE_MODELS.length, ...entries.map(toClaudeCodeModel));
}

export type ModelLimits = { contextWindow: number; maxTokens: number };

/** Applies the limits the CLI reported for a model. The catalog and compaction read these same
 *  objects, so the reported numbers replace the defaults above from the first finished turn on. */
export function learnModelLimits(id: string, limits: ModelLimits): void {
	const model = CLAUDE_CODE_MODELS.find((entry) => entry.id === id);
	if (!model) return;

	Object.assign(model, limits);
}

export function createClaudeCodeProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: CLAUDE_CODE_PROVIDER,
		name: "Claude Code",
		auth: { apiKey: { name: "Claude Code CLI", resolve: async () => ({ auth: {}, source: "claude CLI" }) } },
		models: CLAUDE_CODE_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
