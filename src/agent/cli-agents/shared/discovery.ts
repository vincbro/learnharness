import { spawn } from "node:child_process";

/** One model a CLI offers the signed-in account. efforts lists the reasoning levels it takes
 *  (claude reports them; agy ids carry their own level). */
export type CliModelEntry = { id: string; name: string; efforts?: string[] };

export type CliDiscovery =
	| { ok: true; account: string | null; models: CliModelEntry[] }
	| { ok: false; error: "not-installed" | "not-signed-in" | "failed"; message: string };

export type CliRunResult = { code: number | null; stdout: string; stderr: string };

const DISCOVERY_TIMEOUT_MS = 30_000;

/** Runs a CLI once to completion. With untilLine, the run ends (killed) as soon as one stdout
 *  line passes it, for CLIs that keep a session open. Never rejects. */
export function runCli(
	binary: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd?: string; stdin?: string; untilLine?: (line: string) => boolean },
): Promise<CliRunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve({ code, stdout, stderr });
		};

		const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (options.untilLine && stdout.split("\n").some((line) => options.untilLine!(line))) finish(0);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", (error) => {
			stderr += String(error);
			finish(null);
		});
		child.once("close", (code) => finish(code));

		child.stdin.on("error", () => {});
		if (options.stdin !== undefined) child.stdin.write(options.stdin);
		if (!options.untilLine) child.stdin.end();
	});
}
