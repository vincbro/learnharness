/**
 * POST /api/cli-connections/:provider — Connect, or Refresh models when
 * already connected (owner, 2026-10-28): runs the CLI to check it is signed
 * in and fetch the account's models. A failure is a 400 carrying the reason
 * ({error: "not-installed" | "not-signed-in" | "failed", message}); the
 * saved connection, if any, is left as it was.
 *
 * DELETE — Disconnect: forgets the saved connection and its models.
 * Idempotent. Unknown providers are 404.
 */
import { cliConnectionStatus, connectCli, disconnectCli } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function POST(_req: Request, { params }: Params) {
	const { provider } = await params;
	if (!cliConnectionStatus(provider)) return Response.json({ error: `unknown provider "${provider}"` }, { status: 404 });

	const result = await connectCli(provider);
	if (!result.ok) return Response.json({ error: result.error, message: result.message }, { status: 400 });
	return Response.json({ status: result.status });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { provider } = await params;
	const status = disconnectCli(provider);
	if (!status) return Response.json({ error: `unknown provider "${provider}"` }, { status: 404 });
	return Response.json({ status });
}
