import * as path from "node:path";

import { findBinary, resolveBinary, type BinaryLookup, type BinarySearch } from "../shared/binary.ts";

const AGY_SEARCH: BinarySearch = {
	// The Windows install location is unverified, so only PATH is searched there.
	windows: () => ({ paths: path.win32, names: ["agy.exe", "agy.cmd"], knownDirs: [] }),

	posix(_env, homeDir) {
		const paths = path.posix;

		return {
			paths,
			names: ["agy"],
			knownDirs: [paths.join(homeDir, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
		};
	},
};

export function resolveAgyBinary(lookup: BinaryLookup): string | null {
	return resolveBinary(AGY_SEARCH, lookup);
}

export function getAgyBinary(): string | null {
	return findBinary(AGY_SEARCH);
}
