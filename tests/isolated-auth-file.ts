/**
 * Import FIRST in a test file whose code path reads the auth or CLI
 * connection files: points LH_AUTH_FILE (and with it cli-connections.json)
 * at a fresh tmp dir before config.ts is evaluated, so a developer's real
 * keys and connections never leak in or get overwritten.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-auth-"));
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
