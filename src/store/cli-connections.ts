/**
 * The CLI connections store (owner, 2026-10-28): config.CLI_CONNECTIONS_FILE
 * holds one record per connected subscription CLI — when it was connected,
 * the account it reported, and the model list fetched at Connect / Refresh.
 * Absent provider = not connected. Same doctrine as the auth store: atomic
 * writes, never throws, an absent or corrupt file reads as "nothing
 * connected".
 */

import fs from "node:fs";
import path from "node:path";
import { CLI_CONNECTIONS_FILE } from "../../config.ts";

export type CliConnectionModel = { id: string; name: string; efforts?: string[] };

export type CliConnectionRecord = {
	connectedAt: string;
	refreshedAt: string;
	account: string | null;
	models: CliConnectionModel[];
};

type ConnectionsMap = Record<string, CliConnectionRecord>;

function isModel(value: unknown): value is CliConnectionModel {
	if (!value || typeof value !== "object") return false;
	const model = value as Record<string, unknown>;
	const efforts = model.efforts;
	return typeof model.id === "string" && typeof model.name === "string" && (efforts === undefined || (Array.isArray(efforts) && efforts.every((e) => typeof e === "string")));
}

function toRecord(value: unknown): CliConnectionRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.connectedAt !== "string" || !Array.isArray(raw.models)) return null;

	return {
		connectedAt: raw.connectedAt,
		refreshedAt: typeof raw.refreshedAt === "string" ? raw.refreshedAt : raw.connectedAt,
		account: typeof raw.account === "string" ? raw.account : null,
		models: raw.models.filter(isModel),
	};
}

function readMap(): ConnectionsMap {
	try {
		const raw = JSON.parse(fs.readFileSync(CLI_CONNECTIONS_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(Object.entries(raw).flatMap(([provider, value]) => {
			const record = toRecord(value);
			return record ? [[provider, record]] : [];
		}));
	} catch {
		return {}; // absent or corrupt — nothing connected yet
	}
}

function writeMap(map: ConnectionsMap): void {
	const dir = path.dirname(CLI_CONNECTIONS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.cli-connections.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmp, CLI_CONNECTIONS_FILE);
}

export const cliConnectionStore = {
	get(provider: string): CliConnectionRecord | null {
		return readMap()[provider] ?? null;
	},
	set(provider: string, record: CliConnectionRecord): void {
		writeMap({ ...readMap(), [provider]: record });
	},
	delete(provider: string): void {
		const map = readMap();
		if (!(provider in map)) return;
		delete map[provider];
		writeMap(map);
	},
};
