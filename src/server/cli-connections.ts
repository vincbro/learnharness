/**
 * CLI connections (owner, 2026-10-28): Claude Code and Antigravity run
 * through the user's own signed-in CLI, so connecting one stores no secret.
 * Connect checks the CLI is installed and signed in and fetches the
 * account's models; Refresh re-fetches them; Disconnect forgets them. Only a
 * connected CLI's provider is configured, and its models are exactly the
 * saved list (src/server/model-catalog.ts).
 *
 * The saved lists reach the agent layer (which may not import the store) on
 * this module's first import and on every change — same boot-reflection
 * idea as keys.ts's initAuthEnv.
 */

import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { CLAUDE_CODE_PROVIDER } from "../agent/claude-code/constants.ts";
import { discoverClaudeModels } from "../agent/claude-code/models.ts";
import { setClaudeCodeModels } from "../agent/claude-code/provider.ts";
import { getAgyBinary } from "../agent/cli-agents/antigravity/binary.ts";
import { ANTIGRAVITY_PROVIDER } from "../agent/cli-agents/antigravity/constants.ts";
import { discoverAgyModels } from "../agent/cli-agents/antigravity/models.ts";
import { setAntigravityModels } from "../agent/cli-agents/antigravity/provider.ts";
import type { CliDiscovery, CliModelEntry } from "../agent/cli-agents/shared/discovery.ts";
import { cliConnectionStore } from "../store/cli-connections.ts";

type CliProviderSpec = {
	id: string;
	label: string;
	/** What the user runs in a terminal to sign in. */
	command: string;
	installed: () => boolean;
	discover: () => Promise<CliDiscovery>;
	apply: (models: CliModelEntry[]) => void;
};

const CLI_PROVIDERS: readonly CliProviderSpec[] = [
	{ id: CLAUDE_CODE_PROVIDER, label: "Claude Code", command: "claude", installed: () => getClaudeBinary() !== null, discover: discoverClaudeModels, apply: setClaudeCodeModels },
	{ id: ANTIGRAVITY_PROVIDER, label: "Antigravity", command: "agy", installed: () => getAgyBinary() !== null, discover: discoverAgyModels, apply: setAntigravityModels },
];

export const CLI_PROVIDER_IDS: readonly string[] = CLI_PROVIDERS.map((spec) => spec.id);

/** Test seam (runner.ts's pdfModelOverride idiom): replaces a provider's model discovery. */
export const cliDiscoveryOverride: { current: Partial<Record<string, () => Promise<CliDiscovery>>> } = { current: {} };

export type CliConnectionStatus = {
	provider: string;
	label: string;
	command: string;
	installed: boolean;
	connected: boolean;
	account: string | null;
	models: { id: string; name: string }[];
	connectedAt: string | null;
	refreshedAt: string | null;
};

export type CliConnectResult = { ok: true; status: CliConnectionStatus } | { ok: false; error: string; message: string };

function specFor(provider: string): CliProviderSpec | undefined {
	return CLI_PROVIDERS.find((spec) => spec.id === provider);
}

export function isCliProvider(provider: string | undefined): boolean {
	return !!provider && CLI_PROVIDER_IDS.includes(provider);
}

export function cliConnected(provider: string): boolean {
	return cliConnectionStore.get(provider) !== null;
}

function applySaved(spec: CliProviderSpec): void {
	spec.apply(cliConnectionStore.get(spec.id)?.models ?? []);
}

function toStatus(spec: CliProviderSpec): CliConnectionStatus {
	const record = cliConnectionStore.get(spec.id);

	return {
		provider: spec.id,
		label: spec.label,
		command: spec.command,
		installed: spec.installed(),
		connected: record !== null,
		account: record?.account ?? null,
		models: (record?.models ?? []).map(({ id, name }) => ({ id, name })),
		connectedAt: record?.connectedAt ?? null,
		refreshedAt: record?.refreshedAt ?? null,
	};
}

export function cliConnectionStatuses(): CliConnectionStatus[] {
	return CLI_PROVIDERS.map(toStatus);
}

export function cliConnectionStatus(provider: string): CliConnectionStatus | null {
	const spec = specFor(provider);
	return spec ? toStatus(spec) : null;
}

/** Connect, or Refresh when already connected: fetch the account's models and save them. A
 *  failed refresh keeps the saved list. */
export async function connectCli(provider: string): Promise<CliConnectResult> {
	const spec = specFor(provider);
	if (!spec) return { ok: false, error: "unknown-provider", message: `Unknown CLI provider: ${provider}` };

	const discover = cliDiscoveryOverride.current[provider] ?? spec.discover;
	const discovery = await discover();
	if (!discovery.ok) return { ok: false, error: discovery.error, message: discovery.message };

	const now = new Date().toISOString();
	const previous = cliConnectionStore.get(provider);
	cliConnectionStore.set(provider, { connectedAt: previous?.connectedAt ?? now, refreshedAt: now, account: discovery.account, models: discovery.models });
	applySaved(spec);

	return { ok: true, status: toStatus(spec) };
}

export function disconnectCli(provider: string): CliConnectionStatus | null {
	const spec = specFor(provider);
	if (!spec) return null;

	cliConnectionStore.delete(provider);
	applySaved(spec);

	return toStatus(spec);
}

/** Reflects the saved lists into the agent layer; idempotent. */
export function initCliConnections(): void {
	for (const spec of CLI_PROVIDERS) applySaved(spec);
}

initCliConnections();
