import { createHash } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";

import { hashMessages, planResume, type SessionStamp } from "../shared/session.ts";
import { ANTIGRAVITY_PROVIDER } from "./constants.ts";

export { hashMessages };

const STAMP_PREFIX = "ag1";

/** agy fixes a conversation's system prompt when it is created, so the stamp also records it: a
 *  changed prompt (e.g. the prober→teacher switch) needs a new conversation to take effect. */
export type AgyStamp = SessionStamp & { promptHash: string };

export type AgySessionPlan =
	| { kind: "resume"; conversationId: string; input: Message[] }
	| { kind: "fresh"; reason: string };

export function hashPrompt(systemPrompt: string): string {
	return createHash("sha256").update(systemPrompt).digest("hex");
}

export function toResponseId(stamp: AgyStamp): string {
	return `${STAMP_PREFIX}:${stamp.sessionId}:${stamp.prefixHash}:${stamp.promptHash}`;
}

export function parseResponseId(responseId: string | undefined): AgyStamp | null {
	const [prefix, sessionId, prefixHash, promptHash, ...rest] = (responseId ?? "").split(":");
	if (prefix !== STAMP_PREFIX || !sessionId || !prefixHash || !promptHash || rest.length > 0) return null;

	return { sessionId, prefixHash, promptHash };
}

export function planSession(messages: Message[], systemPrompt: string): AgySessionPlan {
	const plan = planResume(messages, ANTIGRAVITY_PROVIDER, parseResponseId);
	if (plan.kind === "fresh") return plan;

	if (plan.stamp.promptHash !== hashPrompt(systemPrompt)) {
		return { kind: "fresh", reason: "system prompt changed since the conversation started" };
	}

	return { kind: "resume", conversationId: plan.stamp.sessionId, input: plan.input };
}
