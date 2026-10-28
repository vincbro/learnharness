/**
 * Claude Code provider catalog (src/agent/claude-code/provider.ts).
 *
 * Registered on a fresh pi model collection with a stub stream function, so
 * only the catalog and auth surface are under test here. The models are the
 * connected account's (owner, 2026-10-28): set from what the CLI reported.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { clampThinkingLevel, createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { CLAUDE_CODE_PROVIDER } from "../src/agent/claude-code/constants.ts";
import { createClaudeCodeProvider, setClaudeCodeModels } from "../src/agent/claude-code/provider.ts";

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function createCollection() {
	const collection = createModels();
	collection.setProvider(createClaudeCodeProvider(() => createAssistantMessageEventStream()));
	return collection;
}

test.afterEach(() => setClaudeCodeModels([]));

test("lists no models until a connection sets the account's list", () => {
	assert.deepEqual(createCollection().getModels(CLAUDE_CODE_PROVIDER), []);
});

test("lists exactly the models the CLI reported, under their ids and display names", () => {
	const collection = createCollection();
	setClaudeCodeModels([
		{ id: "default", name: "Default (recommended)", efforts: ALL_EFFORTS },
		{ id: "fable", name: "Fable 5.1", efforts: ALL_EFFORTS },
		{ id: "claude-opus-4-6", name: "Opus 4.6", efforts: ALL_EFFORTS },
	]);

	const models = collection.getModels(CLAUDE_CODE_PROVIDER);
	assert.deepEqual(models.map((m) => [m.id, m.name]), [["default", "Default (recommended)"], ["fable", "Fable 5.1"], ["claude-opus-4-6", "Opus 4.6"]]);
});

test("takes the effort levels each model reports, with its lowest as the floor", () => {
	setClaudeCodeModels([{ id: "opus", name: "Opus", efforts: ALL_EFFORTS }, { id: "older", name: "Older", efforts: ["medium", "high"] }]);
	const [opus, older] = createCollection().getModels(CLAUDE_CODE_PROVIDER);
	assert.ok(opus && older);

	assert.deepEqual(getSupportedThinkingLevels(opus), ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(clampThinkingLevel(opus, "off"), "low");
	assert.deepEqual(getSupportedThinkingLevels(older), ["medium", "high"]);
	assert.equal(clampThinkingLevel(older, "low"), "medium");
});

test("a model that reports no effort levels takes no thinking control", () => {
	setClaudeCodeModels([{ id: "haiku-old", name: "Haiku", efforts: [] }]);
	const [model] = createCollection().getModels(CLAUDE_CODE_PROVIDER);
	assert.ok(model);

	assert.equal(model.reasoning, false);
	assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
});

test("accepts text and image input, and every cost field is zero", () => {
	setClaudeCodeModels([{ id: "opus", name: "Opus", efforts: ALL_EFFORTS }]);

	for (const model of createCollection().getModels(CLAUDE_CODE_PROVIDER)) {
		assert.deepEqual(model.input, ["text", "image"]);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
});

test("auth resolves as configured without any key", async () => {
	setClaudeCodeModels([{ id: "opus", name: "Opus", efforts: ALL_EFFORTS }, { id: "sonnet", name: "Sonnet", efforts: ALL_EFFORTS }]);
	const collection = createCollection();

	assert.ok(await collection.checkAuth(CLAUDE_CODE_PROVIDER));
	assert.equal((await collection.getAvailable(CLAUDE_CODE_PROVIDER)).length, 2);
});
