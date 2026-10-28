import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	isExecutable: (path: string) => boolean;
};

export type SearchSpec = {
	paths: path.PlatformPath;
	names: string[];
	knownDirs: string[];
};

/** Where one CLI may be installed, per platform family. */
export type BinarySearch = {
	windows: (env: BinaryLookup["env"], homeDir: string) => SearchSpec;
	posix: (env: BinaryLookup["env"], homeDir: string) => SearchSpec;
};

/** PATH first, then the CLI's known install dirs, per name in preference order. */
export function resolveBinary(search: BinarySearch, { env, platform, homeDir, isExecutable }: BinaryLookup): string | null {
	const { paths, names, knownDirs } = platform === "win32" ? search.windows(env, homeDir) : search.posix(env, homeDir);

	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);

	for (const name of names) {
		for (const dir of [...pathDirs, ...knownDirs]) {
			const candidate = paths.join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}

	return null;
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function findBinary(search: BinarySearch): string | null {
	return resolveBinary(search, {
		env: process.env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}
