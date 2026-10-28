import type { Message } from "@earendil-works/pi-ai";

import { hashMessages, planResume, type SessionStamp } from "../cli-agents/shared/session.ts";
import { CLAUDE_CODE_PROVIDER } from "./constants.ts";

export { hashMessages, type SessionStamp };

const STAMP_PREFIX = "cc1";

export type SessionPlan =
	| { kind: "resume"; sessionId: string; input: Message[] }
	| { kind: "fresh"; reason: string };

export function toResponseId(stamp: SessionStamp): string {
	return `${STAMP_PREFIX}:${stamp.sessionId}:${stamp.prefixHash}`;
}

export function parseResponseId(responseId: string | undefined): SessionStamp | null {
	const [prefix, sessionId, prefixHash, ...rest] = (responseId ?? "").split(":");
	if (prefix !== STAMP_PREFIX || !sessionId || !prefixHash || rest.length > 0) return null;

	return { sessionId, prefixHash };
}

export function planSession(messages: Message[]): SessionPlan {
	const plan = planResume(messages, CLAUDE_CODE_PROVIDER, parseResponseId);

	return plan.kind === "resume" ? { kind: "resume", sessionId: plan.stamp.sessionId, input: plan.input } : plan;
}
