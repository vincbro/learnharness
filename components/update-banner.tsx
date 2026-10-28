"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded); this is the whole
 * renderer surface — a small fixed card, bottom-right, offering Restart.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * No dismiss: a downloaded update installs on quit anyway
 * (autoInstallOnAppQuit); the banner is a courtesy, not a gate.
 *
 * Notify-only builds (unsigned macOS fork releases, owner 2026-10-28) push
 * "available" instead: nothing is downloaded, so the card offers Download,
 * which opens the release page for a manual install.
 */

import { useEffect, useState } from "react";

// The window.lh bridge type lives in components/sidebar.tsx (the incumbent
// declare-global) — onUpdateStatus/installUpdate/openReleases are declared there too.

type UpdateStatus = { status: string; version: string | null };

export default function UpdateBanner() {
	const [ready, setReady] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		// Absent bridge (browser / dev) → stays hidden forever.
		return window.lh?.onUpdateStatus?.((s) => {
			if (s?.status === "downloaded" || s?.status === "available") setReady(s);
		});
	}, []);

	if (!ready) return null;

	const available = ready.status === "available";
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				{available ? (
					<>
						<span className="font-medium">LearnHarness {ready.version ?? "update"} is available</span>
						<span className="text-muted-foreground"> — download it to update.</span>
					</>
				) : (
					<>
						<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
						<span className="text-muted-foreground"> — restart to finish installing.</span>
					</>
				)}
			</div>
			<button
				type="button"
				onClick={() => (available ? window.lh?.openReleases?.() : window.lh?.installUpdate?.())}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				{available ? "Download" : "Restart"}
			</button>
		</div>
	);
}
