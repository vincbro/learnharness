/**
 * CLI connections (src/server/cli-connections.ts) and their catalog gating.
 *
 * LH_AUTH_FILE points at a fresh tmp dir BEFORE the first config import
 * (auth-store.test.ts's discipline), so cli-connections.json lives there and
 * a developer's real connections never leak in. Discovery goes through the
 * cliDiscoveryOverride seam: no CLI runs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cli-connections-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { CLI_CONNECTIONS_FILE } = await import("../config.ts");
const { cliConnected, cliConnectionStatus, cliDiscoveryOverride, connectCli, disconnectCli } = await import("../src/server/cli-connections.ts");
const { catalogContextLimits, catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

const CLAUDE_MODELS = [
	{ id: "opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "fable", name: "Fable 5.1", efforts: ["low", "medium", "high", "xhigh", "max"] },
];

function discoverClaude(models = CLAUDE_MODELS) {
	cliDiscoveryOverride.current["claude-code"] = async () => ({ ok: true, account: "learner@example.com · Claude Pro", models });
}

afterEach(() => {
	cliDiscoveryOverride.current = {};
	disconnectCli("claude-code");
	disconnectCli("antigravity");
});

describe("CLI connections", () => {
	it("starts disconnected: the providers are listed but not configured, and their models are hidden", () => {
		assert.equal(cliConnected("claude-code"), false);
		assert.deepEqual(catalogProviders().find((p) => p.id === "claude-code"), { id: "claude-code", envVar: "", keyPresent: false });
		assert.deepEqual(catalogProviders().find((p) => p.id === "antigravity"), { id: "antigravity", envVar: "", keyPresent: false });
		assert.equal(providerKeyPresent("claude-code"), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === "claude-code" || m.provider === "antigravity"), false);
	});

	it("Connect saves the account's models; the catalog then lists exactly those", async () => {
		discoverClaude();

		const result = await connectCli("claude-code");
		assert.ok(result.ok);
		assert.equal(result.status.connected, true);
		assert.equal(result.status.account, "learner@example.com · Claude Pro");
		assert.deepEqual(result.status.models, [{ id: "opus", name: "Opus 5.5" }, { id: "fable", name: "Fable 5.1" }]);

		assert.equal(providerKeyPresent("claude-code"), true);
		assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "claude-code").map((m) => m.id), ["fable", "opus"]);
		assert.ok((catalogContextLimits().get("claude-code:opus") ?? 0) > 0);
		assert.equal(piEngineForSpec({ provider: "claude-code", id: "fable" }).model.id, "fable");

		const saved = JSON.parse(fs.readFileSync(CLI_CONNECTIONS_FILE, "utf8")) as Record<string, { models: unknown[] }>;
		assert.equal(saved["claude-code"]?.models.length, 2);
		assert.equal(fs.statSync(CLI_CONNECTIONS_FILE).mode & 0o777, 0o600);
	});

	it("Refresh replaces the model list but keeps when it was first connected", async () => {
		discoverClaude();
		const first = await connectCli("claude-code");
		assert.ok(first.ok);

		discoverClaude([{ id: "argon", name: "Argon", efforts: [] }]);
		const refreshed = await connectCli("claude-code");
		assert.ok(refreshed.ok);

		assert.equal(refreshed.status.connectedAt, first.status.connectedAt);
		assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "claude-code").map((m) => m.id), ["argon"]);
	});

	it("a failed Connect saves nothing and reports why; a failed Refresh keeps the saved list", async () => {
		cliDiscoveryOverride.current["antigravity"] = async () => ({ ok: false, error: "not-signed-in", message: "agy CLI is not signed in" });
		assert.deepEqual(await connectCli("antigravity"), { ok: false, error: "not-signed-in", message: "agy CLI is not signed in" });
		assert.equal(cliConnected("antigravity"), false);

		discoverClaude();
		await connectCli("claude-code");
		cliDiscoveryOverride.current["claude-code"] = async () => ({ ok: false, error: "failed", message: "boom" });
		assert.equal((await connectCli("claude-code")).ok, false);
		assert.equal(cliConnectionStatus("claude-code")?.models.length, 2);
	});

	it("Disconnect forgets the connection and hides the provider's models again", async () => {
		cliDiscoveryOverride.current["antigravity"] = async () => ({ ok: true, account: null, models: [{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }] });
		await connectCli("antigravity");
		assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "antigravity").map((m) => m.id), ["gemini-3.8-flash-low"]);

		const status = disconnectCli("antigravity");
		assert.equal(status?.connected, false);
		assert.equal(providerKeyPresent("antigravity"), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === "antigravity"), false);
	});

	it("unknown providers are rejected", async () => {
		assert.equal(cliConnectionStatus("nope"), null);
		assert.equal(disconnectCli("nope"), null);
		assert.deepEqual(await connectCli("nope"), { ok: false, error: "unknown-provider", message: "Unknown CLI provider: nope" });
	});
});
