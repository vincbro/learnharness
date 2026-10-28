import { createHash } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";

import { hashMessages, planResume, type SessionStamp } from "../shared/session.ts";
import { ANTIGRAVITY_PROVIDER } from "./constants.ts";

export { hashMessages };

const STAMP_PREFIX = "ag1";

/** agy fixes a conversation's agent prompt (system prompt plus tool schemas) when it is created,
 *  so the stamp also records it: a changed prompt or tool set (e.g. the prober→teacher switch)
 *  needs a new conversation to take effect. */
export type AgyStamp = SessionStamp & { promptHash: string };

export type AgySessionPlan =
	| { kind: "resume"; conversationId: string; input: Message[] }
	| { kind: "fresh"; reason: string };

export function hashPrompt(agentPrompt: string): string {
	return createHash("sha256").update(agentPrompt).digest("hex");
}

export function toResponseId(stamp: AgyStamp): string {
	return `${STAMP_PREFIX}:${stamp.sessionId}:${stamp.prefixHash}:${stamp.promptHash}`;
}

export function parseResponseId(responseId: string | undefined): AgyStamp | null {
	const [prefix, sessionId, prefixHash, promptHash, ...rest] = (responseId ?? "").split(":");
	if (prefix !== STAMP_PREFIX || !sessionId || !prefixHash || !promptHash || rest.length > 0) return null;

	return { sessionId, prefixHash, promptHash };
}

export function planSession(messages: Message[], agentPrompt: string): AgySessionPlan {
	const plan = planResume(messages, ANTIGRAVITY_PROVIDER, parseResponseId);
	if (plan.kind === "fresh") return plan;

	if (plan.stamp.promptHash !== hashPrompt(agentPrompt)) {
		return { kind: "fresh", reason: "system prompt or tools changed since the conversation started" };
	}

	return { kind: "resume", conversationId: plan.stamp.sessionId, input: plan.input };
}
