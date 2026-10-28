/**
 * Claude Code / Antigravity connection rows (components/settings/cli-connections.tsx):
 * mounted with fetch stubbed, through Connect's failure and success, Refresh and Disconnect
 * (classic-JSX shim + linkedom, as in render-update-banner.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import { CliConnections, type CliConnectionStatus } from "../components/settings/cli-connections.tsx";

const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;
// notifySettingsSaved dispatches on window: the event must be linkedom's, not Node's global one.
(globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;

const CLAUDE: CliConnectionStatus = { provider: "claude-code", label: "Claude Code", command: "claude", installed: true, connected: false, account: null, models: [], connectedAt: null, refreshedAt: null };
const AGY: CliConnectionStatus = { provider: "antigravity", label: "Antigravity", command: "agy", installed: false, connected: false, account: null, models: [], connectedAt: null, refreshedAt: null };
const CONNECTED: CliConnectionStatus = { ...CLAUDE, connected: true, account: "learner@example.com · Claude Pro", models: [{ id: "opus", name: "Opus 5.5" }, { id: "fable", name: "Fable 5.1" }], connectedAt: "t", refreshedAt: "t" };

type Call = { url: string; method: string };

function stubFetch(replies: Record<string, (call: Call) => { status: number; body: unknown }>): Call[] {
	const calls: Call[] = [];
	(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string }) => {
		const call = { url, method: init?.method ?? "GET" };
		calls.push(call);
		const reply = replies[`${call.method} ${url}`];
		assert.ok(reply, `unexpected ${call.method} ${url}`);
		const { status, body } = reply(call);
		return { ok: status < 400, status, json: async () => body };
	};
	return calls;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = ReactDOMClient.createRoot(host);
	flushSync(() => root.render(<CliConnections />));
	await tick(); await tick();
	return { host, unmount: () => { root.unmount(); host.remove(); } };
}

// Booleans, not nodes: a failed assert would otherwise try to print a whole linkedom tree.
function dialogOpen(): boolean {
	return document.querySelector("[data-testid='cli-connection-dialog']") !== null;
}

/** A button in the open dialog (the rows carry "Connect" too). */
function button(label: string): HTMLButtonElement {
	const dialog = document.querySelector("[data-testid='cli-connection-dialog']");
	assert.ok(dialog, "dialog open");
	const found = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
	assert.ok(found, `button "${label}"`);
	return found!;
}

async function click(label: string): Promise<void> {
	flushSync(() => button(label).click());
	await tick(); await tick(); await tick();
}

describe("CLI connections on the Keys page", () => {
	afterEach(() => { document.body.innerHTML = ""; });

	it("lists a Connect row per CLI; a missing CLI's dialog says to install it and cannot connect", async () => {
		stubFetch({ "GET /api/cli-connections": () => ({ status: 200, body: { connections: [CLAUDE, AGY] } }) });
		const { host, unmount } = await mount();

		assert.ok(host.querySelector("[data-testid='claude-code-connection']"));
		assert.ok(host.querySelector("[data-testid='antigravity-connection']"));

		flushSync(() => (host.querySelector("[data-testid='antigravity-connection'] button") as HTMLButtonElement).click());
		const dialog = document.querySelector("[data-testid='cli-connection-dialog']");
		assert.ok(dialog?.textContent?.includes("was not found on this computer"));
		assert.ok(button("Connect").disabled);
		unmount();
	});

	it("a signed-out CLI gets sign-in guidance and Retry; a successful Connect lists the models and tells the picker", async () => {
		let attempts = 0;
		const calls = stubFetch({
			"GET /api/cli-connections": () => ({ status: 200, body: { connections: [CLAUDE] } }),
			"POST /api/cli-connections/claude-code": () => (++attempts === 1
				? { status: 400, body: { error: "not-signed-in", message: "claude CLI is not signed in" } }
				: { status: 200, body: { status: CONNECTED } }),
		});
		const saved: string[] = [];
		window.addEventListener("lh:settings-saved", (event) => saved.push((event as CustomEvent<{ section: string }>).detail.section));
		const { host, unmount } = await mount();

		flushSync(() => (host.querySelector("[data-testid='claude-code-connection'] button") as HTMLButtonElement).click());
		assert.ok(document.querySelector("[data-testid='cli-connection-notice']")?.textContent?.includes("`claude` CLI"));

		await click("Connect");
		assert.ok(document.querySelector("[role='alert']")?.textContent?.includes("Run `claude` once in a terminal to sign in"));

		await click("Retry");
		assert.equal(dialogOpen(), false, "a first connect closes the dialog");
		assert.ok(host.textContent?.includes("Manage…"));
		assert.ok(host.textContent?.includes("2 models"));
		assert.deepEqual(saved, ["keys"]);
		assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "POST"]);
		unmount();
	});

	it("Manage shows the account and models; Disconnect asks first, then forgets the connection", async () => {
		const calls = stubFetch({
			"GET /api/cli-connections": () => ({ status: 200, body: { connections: [CONNECTED] } }),
			"POST /api/cli-connections/claude-code": () => ({ status: 200, body: { status: CONNECTED } }),
			"DELETE /api/cli-connections/claude-code": () => ({ status: 200, body: { status: CLAUDE } }),
		});
		const { host, unmount } = await mount();

		flushSync(() => (host.querySelector("[data-testid='claude-code-connection'] button") as HTMLButtonElement).click());
		const details = document.querySelector("[data-testid='cli-connection-details']");
		assert.ok(details?.textContent?.includes("learner@example.com · Claude Pro"));
		assert.equal(document.querySelectorAll("[data-testid='cli-connection-models'] li").length, 2);

		await click("Refresh models");
		assert.equal(dialogOpen(), true, "a refresh keeps the dialog open");

		await click("Disconnect");
		assert.ok(document.querySelector("[data-testid='cli-connection-dialog']")?.textContent?.includes("Disconnect Claude Code?"));
		await click("Disconnect");

		assert.equal(dialogOpen(), false);
		assert.ok(host.textContent?.includes("Connect"));
		assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "DELETE"]);
		unmount();
	});
});
