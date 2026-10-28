import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

/** One model as `agy models` lists it. */
export type AntigravityModelEntry = { id: string; name: string };

const SHARED_MODEL_FIELDS = {
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	// agy's stream-json input takes text blocks only; images are replaced with a note.
	input: ["text"],
	// Billed to the user's Google account, not per token.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// Each agy model id carries its own reasoning level (e.g. gemini-3.8-flash-low), so the app
	// offers no thinking control.
	reasoning: false,
	// agy reports no limits; conservative for every model it may list (owner, 2026-10-28).
	contextWindow: 200_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name">;

/** The connected account's models. Filled from the saved connection and replaced in place on
 *  connect and refresh: the provider reads this array on every lookup. */
export const ANTIGRAVITY_MODELS: Model<Api>[] = [];

export function toAntigravityModel(entry: AntigravityModelEntry): Model<Api> {
	return { ...SHARED_MODEL_FIELDS, id: entry.id, name: entry.name };
}

export function setAntigravityModels(entries: AntigravityModelEntry[]): void {
	ANTIGRAVITY_MODELS.splice(0, ANTIGRAVITY_MODELS.length, ...entries.map(toAntigravityModel));
}

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: ANTIGRAVITY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
