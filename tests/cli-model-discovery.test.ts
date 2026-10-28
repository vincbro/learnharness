/**
 * CLI model discovery parsers: claude's initialize control response
 * (src/agent/claude-code/models.ts) and `agy models` output
 * (src/agent/cli-agents/antigravity/models.ts), plus the Antigravity
 * provider's model shape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { parseInitializeResponse } from "../src/agent/claude-code/models.ts";
import { ANTIGRAVITY_PROVIDER } from "../src/agent/cli-agents/antigravity/constants.ts";
import { parseAgyModels } from "../src/agent/cli-agents/antigravity/models.ts";
import { createAntigravityProvider, setAntigravityModels } from "../src/agent/cli-agents/antigravity/provider.ts";

function initializeLine(response: object): string {
	return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "learnharness-models", response } });
}

const OPUS = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] };

test("claude: a signed-in account yields its models with effort levels, and the account label", () => {
	const line = initializeLine({
		models: [OPUS, { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }],
		account: { email: "learner@example.com", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
	});

	assert.deepEqual(parseInitializeResponse(line), {
		ok: true,
		account: "learner@example.com · Claude Pro",
		models: [
			{ id: "opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
			{ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", efforts: [] },
		],
	});
});

test("claude: no token source means signed out, even though models are listed", () => {
	const line = initializeLine({ models: [OPUS], account: { tokenSource: "none", apiProvider: "firstParty" } });

	assert.deepEqual(parseInitializeResponse(line), { ok: false, error: "not-signed-in", message: "claude CLI is not signed in" });
});

test("claude: an empty or unreadable response fails", () => {
	assert.equal(parseInitializeResponse(initializeLine({ models: [], account: { email: "a@b.c" } })).ok, false);
	assert.equal(parseInitializeResponse("not json").ok, false);
});

test("agy: each id<TAB>name line is a model; anything else is skipped", () => {
	const stdout = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nargon-1\tArgon\n\nnoise without a tab\n";

	assert.deepEqual(parseAgyModels(stdout), [
		{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
		{ id: "argon-1", name: "Argon" },
	]);
});

test("agy: models are text-only, free, without thinking control, at the conservative limits", () => {
	const collection = createModels();
	collection.setProvider(createAntigravityProvider(() => createAssistantMessageEventStream()));
	setAntigravityModels([{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }]);
	test.after(() => setAntigravityModels([]));

	const [model] = collection.getModels(ANTIGRAVITY_PROVIDER);
	assert.ok(model);
	assert.deepEqual(model.input, ["text"]);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
	assert.deepEqual([model.contextWindow, model.maxTokens], [200_000, 64_000]);
});
