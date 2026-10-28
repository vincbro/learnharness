"use client";

/**
 * Claude Code / Antigravity connections on the Keys page (owner,
 * 2026-10-28). These run through the user's own signed-in CLI, so Connect
 * stores no credentials: it checks the CLI is installed and signed in and
 * fetches the account's models (POST /api/cli-connections/:provider);
 * Refresh models re-fetches; Disconnect forgets the saved list. Only a
 * connected CLI's models reach the picker.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";

export type CliConnectionStatus = {
	provider: string;
	label: string;
	command: string;
	installed: boolean;
	connected: boolean;
	account: string | null;
	models: { id: string; name: string }[];
	connectedAt: string | null;
	refreshedAt: string | null;
};

type ConnectError = { error: string; message: string };

export function cliConnectionNotice(label: string, command: string): string {
	return `Your prompts, tool results, and relevant session context are sent to ${label} through the \`${command}\` CLI on this computer, using the account you are signed into there. LearnHarness stores no credentials for it. Provider terms, data-use policies, and plan limits apply.`;
}

export function cliDisconnectCopy(label: string): string {
	return `Disconnect ${label} from LearnHarness? Its models leave the picker until you connect again. This does not sign you out of the CLI. Saved model choices will remain unavailable until you reconnect or change them.`;
}

export function cliConnectErrorCopy(failure: ConnectError, label: string, command: string): string {
	switch (failure.error) {
		case "not-installed":
			return `The ${label} CLI (\`${command}\`) was not found on this computer. Install it, then try again.`;
		case "not-signed-in":
			return `The ${label} CLI is not signed in. Run \`${command}\` once in a terminal to sign in, then retry.`;
		default:
			return `${label} could not be checked: ${failure.message}`;
	}
}

function isStatus(value: unknown): value is CliConnectionStatus {
	if (!value || typeof value !== "object") return false;
	const s = value as CliConnectionStatus;
	return typeof s.provider === "string" && typeof s.label === "string" && typeof s.connected === "boolean" && Array.isArray(s.models);
}

const LOAD_ERROR = "The connection state could not be loaded. Try again.";

function CliConnectionDialog({ status, onClose, onChange }: { status: CliConnectionStatus; onClose: () => void; onChange: (status: CliConnectionStatus) => void }) {
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => () => void (mounted.current = false), []);

	async function connect() {
		setBusy(true); setError(null);
		try {
			const res = await fetch(`/api/cli-connections/${status.provider}`, { method: "POST" });
			const body: unknown = await res.json();
			if (!mounted.current) return;
			if (res.ok && body && typeof body === "object" && isStatus((body as { status?: unknown }).status)) {
				onChange((body as { status: CliConnectionStatus }).status);
				notifySettingsSaved("keys");
				if (!status.connected) onClose();
				return;
			}
			const failure = body as Partial<ConnectError>;
			setError(cliConnectErrorCopy({ error: failure.error ?? "failed", message: failure.message ?? `HTTP ${res.status}` }, status.label, status.command));
		} catch {
			if (mounted.current) setError(cliConnectErrorCopy({ error: "failed", message: "the app server did not answer" }, status.label, status.command));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function disconnect() {
		setBusy(true); setError(null);
		try {
			const res = await fetch(`/api/cli-connections/${status.provider}`, { method: "DELETE" });
			const body: unknown = await res.json();
			if (!mounted.current) return;
			if (res.ok && body && typeof body === "object" && isStatus((body as { status?: unknown }).status)) {
				onChange((body as { status: CliConnectionStatus }).status);
				notifySettingsSaved("keys");
				onClose();
				return;
			}
			setError(LOAD_ERROR);
		} catch {
			if (mounted.current) setError(LOAD_ERROR);
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	function close() {
		if (busy) return;
		if (confirm) { setConfirm(false); return; }
		onClose();
	}

	return <ConnectionDialog label={`${status.label} connection`} testid="cli-connection-dialog" backdropTestid="cli-connection-backdrop" busy={busy} onClose={close}>
		<h2 className="text-sm font-semibold text-foreground">{status.label}</h2>
		{confirm ? <>
			<p className="mt-3 text-sm font-semibold text-red-400">Disconnect {status.label}?</p>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{cliDisconnectCopy(status.label)}</p>
		</> : status.connected ? <div className="mt-3 space-y-2 text-xs text-muted-foreground" data-testid="cli-connection-details">
			{status.account && <p>Signed in as <span className="text-foreground">{status.account}</span></p>}
			<p>{status.models.length} {status.models.length === 1 ? "model" : "models"} available:</p>
			<ul className="max-h-40 overflow-y-auto rounded-sm border border-border px-2 py-1 font-mono" data-testid="cli-connection-models">
				{status.models.map((model) => <li key={model.id} className="truncate" title={model.name}>{model.id}</li>)}
			</ul>
		</div> : <>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="cli-connection-notice">{cliConnectionNotice(status.label, status.command)}</p>
			{!status.installed && <p className="mt-3 text-xs text-muted-foreground">The <code className="font-mono">{status.command}</code> CLI was not found on this computer. Install it to connect.</p>}
		</>}
		{busy && !confirm && <p role="status" className="mt-3 text-xs text-muted-foreground">Checking {status.label}…</p>}
		{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
		<ConnectionFooter testid="cli-connection-footer" leading={!confirm && status.connected && <Button variant="ghost" size="sm" className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-300" disabled={busy} onClick={() => setConfirm(true)}>Disconnect</Button>}>
			<Button variant="ghost" size="sm" disabled={busy} onClick={close}>{confirm || !status.connected ? "Cancel" : "Close"}</Button>
			{confirm
				? <Button variant="destructive" size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
				: <Button variant="outline" size="sm" disabled={busy || (!status.connected && !status.installed)} onClick={() => void connect()}>{status.connected ? "Refresh models" : error ? "Retry" : "Connect"}</Button>}
		</ConnectionFooter>
	</ConnectionDialog>;
}

export function CliConnections() {
	const [statuses, setStatuses] = useState<CliConnectionStatus[]>([]);
	const [open, setOpen] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		fetch("/api/cli-connections")
			.then((res) => res.json())
			.then((body: unknown) => {
				const list = body && typeof body === "object" ? (body as { connections?: unknown }).connections : undefined;
				if (live && Array.isArray(list)) setStatuses(list.filter(isStatus));
			})
			.catch(() => { if (live) setError(LOAD_ERROR); });
		return () => { live = false; };
	}, []);

	const current = statuses.find((s) => s.provider === open);
	const replace = (next: CliConnectionStatus) => setStatuses((list) => list.map((s) => (s.provider === next.provider ? next : s)));

	return <>
		{statuses.map((status) => <div key={status.provider} className="flex flex-col gap-2" data-testid={`${status.provider}-connection`}>
			<ConnectionRow label={status.label} action={status.connected ? "Manage…" : "Connect"} disabled={false} onAction={() => setOpen(status.provider)}>
				{status.connected && <span className="text-xs text-muted-foreground">{status.models.length} {status.models.length === 1 ? "model" : "models"}</span>}
			</ConnectionRow>
		</div>)}
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{current && <CliConnectionDialog status={current} onClose={() => setOpen(null)} onChange={replace} />}
	</>;
}
