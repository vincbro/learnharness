import { tmpdir } from "node:os";

import { runCli, type CliDiscovery, type CliModelEntry } from "../shared/discovery.ts";
import { getAgyBinary } from "./binary.ts";

const SIGN_IN_REQUIRED = "Please sign in";

/** `agy models` prints one "id<TAB>name" line per model on stdout. */
export function parseAgyModels(stdout: string): CliModelEntry[] {
	return stdout.split("\n").flatMap((line) => {
		const [id, name] = line.split("\t").map((part) => part.trim());
		return id && name ? [{ id, name }] : [];
	});
}

export async function discoverAgyModels(): Promise<CliDiscovery> {
	const binary = getAgyBinary();
	if (!binary) return { ok: false, error: "not-installed", message: "agy CLI not found" };

	const run = await runCli(binary, ["models"], { cwd: tmpdir(), env: process.env });
	if (run.stderr.includes(SIGN_IN_REQUIRED)) return { ok: false, error: "not-signed-in", message: "agy CLI is not signed in" };

	const models = parseAgyModels(run.stdout);
	if (run.code !== 0 || models.length === 0) {
		return { ok: false, error: "failed", message: run.stderr.trim() || `agy models exited with code ${run.code}` };
	}

	// agy has no account command; a model list means it is signed in.
	return { ok: true, account: null, models };
}
