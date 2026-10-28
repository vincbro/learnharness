import * as path from "node:path";

import { findBinary, resolveBinary, type BinaryLookup, type BinarySearch } from "../cli-agents/shared/binary.ts";

const CLAUDE_SEARCH: BinarySearch = {
	windows(env, homeDir) {
		const paths = path.win32;
		const appData = env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming");

		return {
			paths,
			names: ["claude.exe", "claude.cmd"],
			knownDirs: [
				paths.join(homeDir, ".local", "bin"),
				paths.join(homeDir, ".claude", "local"),
				env.npm_config_prefix ?? paths.join(appData, "npm"),
			],
		};
	},

	posix(env, homeDir) {
		const paths = path.posix;
		const npmBin = env.npm_config_prefix
			? paths.join(env.npm_config_prefix, "bin")
			: paths.join(homeDir, ".npm-global", "bin");

		return {
			paths,
			names: ["claude"],
			knownDirs: [
				paths.join(homeDir, ".local", "bin"),
				paths.join(homeDir, ".claude", "local"),
				npmBin,
				"/opt/homebrew/bin",
				"/usr/local/bin",
			],
		};
	},
};

export function resolveClaudeBinary(lookup: BinaryLookup): string | null {
	return resolveBinary(CLAUDE_SEARCH, lookup);
}

export function getClaudeBinary(): string | null {
	return findBinary(CLAUDE_SEARCH);
}
