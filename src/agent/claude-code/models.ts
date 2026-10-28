import { tmpdir } from "node:os";

import { runCli, type CliDiscovery, type CliModelEntry } from "../cli-agents/shared/discovery.ts";
import { getClaudeBinary } from "./binary.ts";
import { toClaudeEnv } from "./stream.ts";

const REQUEST_ID = "learnharness-models";

// The control request the Agent SDK opens a session with; its response lists the account's
// models without sending a prompt.
const INITIALIZE_REQUEST = JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } });

const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--tools", ""];

type RawModel = { value?: unknown; displayName?: unknown; supportedEffortLevels?: unknown };

type RawAccount = { email?: unknown; subscriptionType?: unknown; tokenSource?: unknown };

type RawInitialize = { models?: RawModel[]; account?: RawAccount };

function isControlResponse(line: string): boolean {
	try {
		const parsed = JSON.parse(line) as { type?: string; response?: { request_id?: string } };
		return parsed.type === "control_response" && parsed.response?.request_id === REQUEST_ID;
	} catch {
		return false;
	}
}

function toEntry(raw: RawModel): CliModelEntry | null {
	if (typeof raw.value !== "string" || !raw.value) return null;

	const name = typeof raw.displayName === "string" && raw.displayName ? raw.displayName : raw.value;
	const efforts = Array.isArray(raw.supportedEffortLevels) ? raw.supportedEffortLevels.filter((level): level is string => typeof level === "string") : [];

	return { id: raw.value, name, efforts };
}

// Signed out, the CLI still lists models but reports no token source.
function toAccount(raw: RawAccount | undefined): string | null | "signed-out" {
	if (!raw || raw.tokenSource === "none") return "signed-out";

	const parts = [raw.email, raw.subscriptionType].filter((part): part is string => typeof part === "string" && part.length > 0);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** Reads the models and account out of the initialize control response line. */
export function parseInitializeResponse(line: string): CliDiscovery {
	let response: RawInitialize | undefined;
	try {
		response = (JSON.parse(line) as { response?: { response?: RawInitialize } }).response?.response;
	} catch {
		response = undefined;
	}

	if (!response) return { ok: false, error: "failed", message: "claude CLI sent no model list" };

	const account = toAccount(response.account);
	if (account === "signed-out") return { ok: false, error: "not-signed-in", message: "claude CLI is not signed in" };

	const models = (response.models ?? []).flatMap((raw) => toEntry(raw) ?? []);
	if (models.length === 0) return { ok: false, error: "failed", message: "claude CLI listed no models" };

	return { ok: true, account, models };
}

export async function discoverClaudeModels(): Promise<CliDiscovery> {
	const binary = getClaudeBinary();
	if (!binary) return { ok: false, error: "not-installed", message: "claude CLI not found" };

	const run = await runCli(binary, ARGS, {
		cwd: tmpdir(),
		env: toClaudeEnv(process.env),
		stdin: `${INITIALIZE_REQUEST}\n`,
		untilLine: isControlResponse,
	});

	const line = run.stdout.split("\n").find(isControlResponse);
	if (!line) return { ok: false, error: "failed", message: run.stderr.trim() || "claude CLI did not answer" };

	return parseInitializeResponse(line);
}
