/**
 * GET /api/cli-connections — the Keys page's Claude Code / Antigravity rows
 * (owner, 2026-10-28): per CLI, whether it is installed and connected, the
 * account it reported and the saved model list.
 */
import { cliConnectionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ connections: cliConnectionStatuses() });
}
