/**
 * The repair loop (owner design, 2026-10-27): a wrong teach-phase CHECK hides
 * its answer, the teacher may ask the learner to `reflect` on why, guides him
 * to the answer in conversation, then poses a new check on the same plan node.
 * Everything here is derived from the transcript, never stored:
 *
 * - a check's verdict: multiple choice grades itself; free recall takes the
 *   verdict of the teacher's `grade` call (correct | partial | incorrect);
 * - a wrong check's answer stays hidden until a LATER check on the same node
 *   is correct — then it unlocks for review;
 * - a reflect call is about the latest answered check before it.
 *
 * Checks are teach quiz/explain calls tagged with a nodeId whose type is not
 * "predict". Predictions and probe questions are untouched.
 *
 * Two readers of one fold: the native record (the reflect/grade tools'
 * gates) and the UI's typed parts (the cards).
 */

import { normalizeQuizType, type QuestionAnswerData } from "./question-core.ts";
import type { LhMessage } from "./native-messages.ts";

export const GRADE_VERDICTS = ["correct", "partial", "incorrect"] as const;
export type GradeVerdict = (typeof GRADE_VERDICTS)[number];
export type CheckVerdict = GradeVerdict | "ungraded";

/** The grade tool's record-facing details: which check it graded. */
export interface GradeDetails {
	gradedToolCallId: string;
	verdict: GradeVerdict;
}

export interface AnsweredCheck {
	toolCallId: string;
	tool: "quiz" | "explain";
	nodeId: string;
	answer: QuestionAnswerData;
	verdict: CheckVerdict;
}

export interface RepairState {
	/** Answered checks in answer order. */
	checks: AnsweredCheck[];
	/** reflect call id → the check it is about (the latest answered one before it). */
	reflectTargets: Map<string, AnsweredCheck>;
}

type RepairEvent =
	| { kind: "call"; id: string; name: string; input: unknown }
	| { kind: "result"; id: string; output: unknown; isError: boolean };

function checkCallNodeId(name: string, input: unknown): string | null {
	if (name !== "quiz" && name !== "explain") return null;

	const fields = input as { type?: unknown; nodeId?: unknown } | null;
	if (typeof fields?.nodeId !== "string" || fields.nodeId.length === 0) return null;
	if (normalizeQuizType(fields.type) === "predict") return null;

	return fields.nodeId;
}

function isGradeDetails(value: unknown): value is GradeDetails {
	const details = value as Partial<GradeDetails> | null;
	return (
		typeof details?.gradedToolCallId === "string" &&
		(GRADE_VERDICTS as readonly string[]).includes(details.verdict as string)
	);
}

function isAnswer(value: unknown): value is QuestionAnswerData {
	return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function foldRepair(events: readonly RepairEvent[]): RepairState {
	const calls = new Map<string, { name: string; nodeId: string | null }>();
	const checks: AnsweredCheck[] = [];
	const byId = new Map<string, AnsweredCheck>();
	const reflectTargets = new Map<string, AnsweredCheck>();

	for (const event of events) {
		if (event.kind === "call") {
			calls.set(event.id, { name: event.name, nodeId: checkCallNodeId(event.name, event.input) });

			const latest = checks.at(-1);
			if (event.name === "reflect" && latest) reflectTargets.set(event.id, latest);
			continue;
		}

		const call = calls.get(event.id);
		if (!call || event.isError) continue;

		if (call.name === "grade") {
			if (!isGradeDetails(event.output)) continue;

			const graded = byId.get(event.output.gradedToolCallId);
			if (graded?.tool === "explain") graded.verdict = event.output.verdict;
			continue;
		}

		if (!call.nodeId || !isAnswer(event.output) || event.output.dismissed || byId.has(event.id)) continue;

		const tool = call.name === "explain" ? "explain" : "quiz";
		const verdict: CheckVerdict = tool === "explain" ? "ungraded" : event.output.correct === true ? "correct" : "incorrect";
		const check: AnsweredCheck = { toolCallId: event.id, tool, nodeId: call.nodeId, answer: event.output, verdict };

		checks.push(check);
		byId.set(event.id, check);
	}

	return { checks, reflectTargets };
}

/** The fold over the native record (server: the reflect and grade gates). */
export function repairStateLh(messages: readonly LhMessage[]): RepairState {
	const events: RepairEvent[] = [];

	for (const message of messages) {
		const role = (message as { role?: string }).role;

		if (role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;

			for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
				if (block.type === "toolCall" && block.id && block.name) {
					events.push({ kind: "call", id: block.id, name: block.name, input: block.arguments });
				}
			}
		}

		if (role === "toolResult") {
			const result = message as { toolCallId?: string; details?: unknown; isError?: boolean };
			if (result.toolCallId) events.push({ kind: "result", id: result.toolCallId, output: result.details, isError: result.isError === true });
		}
	}

	return foldRepair(events);
}

/** Minimal typed-parts slice (the UI's messages; mirrors contracts/plan.ts). */
interface PartsCarrier {
	parts: Array<{ type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown }>;
}

/** The fold over the UI's typed parts (client: the cards). */
export function repairStateFromParts(messages: readonly PartsCarrier[]): RepairState {
	const events: RepairEvent[] = [];

	for (const message of messages) {
		for (const part of message.parts) {
			if (!part.type.startsWith("tool-") || !part.toolCallId) continue;

			events.push({ kind: "call", id: part.toolCallId, name: part.type.slice("tool-".length), input: part.input });
			if (part.state === "output-available") events.push({ kind: "result", id: part.toolCallId, output: part.output, isError: false });
		}
	}

	return foldRepair(events);
}

/** The latest answered check — the subject of a reflect or grade call. */
export function latestAnsweredCheck(state: RepairState): AnsweredCheck | undefined {
	return state.checks.at(-1);
}

/** Whether a check's correct answer may be shown: it was answered correctly,
 *  or a later check on the same node was. */
export function checkRevealed(state: RepairState, toolCallId: string): boolean {
	const index = state.checks.findIndex((check) => check.toolCallId === toolCallId);
	const check = state.checks[index];
	if (!check) return true;
	if (check.verdict === "correct") return true;

	return state.checks.slice(index + 1).some((later) => later.nodeId === check.nodeId && later.verdict === "correct");
}

export function checkVerdict(state: RepairState, toolCallId: string): CheckVerdict | undefined {
	return state.checks.find((check) => check.toolCallId === toolCallId)?.verdict;
}
