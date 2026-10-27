/**
 * The repair loop (src/core/repair.ts + the teacher's reflect/grade tools in
 * src/agent/tools.ts): check verdicts, hidden answers that unlock after a
 * correct follow-up on the same node, reflect targets, and the tools' gates.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";

import { PATHS } from "../config.ts";
import { gradeToolFor, reflectToolFor } from "../src/agent/tools.ts";
import { newAnswerResult, newMessageId, type LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import {
	checkRevealed,
	checkVerdict,
	latestAnsweredCheck,
	repairStateFromParts,
	repairStateLh,
} from "../src/core/repair.ts";
import { chatStore } from "../src/store/chats.ts";

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function call(id: string, name: string, args: JsonObject): LhMessage {
	const message: AssistantMessage & { id: string } = {
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};
	return message;
}

function check(id: string, nodeId: string, name: "quiz" | "explain" = "quiz", type = "check"): LhMessage {
	return call(id, name, { type, nodeId, question: `Q ${id}` });
}

function quizAnswer(correct: boolean): QuestionAnswerData {
	return {
		kind: "quiz",
		questionText: "Q",
		dontKnow: false,
		answers: [{ label: "B", value: "b", index: 2 }],
		correct,
		correctIndices: [1],
		explanation: "Because A.",
		answeredAt: "2026-10-27T00:00:00.000Z",
	};
}

function explainAnswer(): QuestionAnswerData {
	return { kind: "explain", questionText: "Q", dontKnow: false, answers: [], text: "my words", committed: "the answer", answeredAt: "2026-10-27T00:00:00.000Z" };
}

function gradeResult(callId: string, gradedToolCallId: string, verdict: string): LhMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId: callId,
		toolName: "grade",
		content: [{ type: "text", text: `Graded ${verdict}.` }],
		details: { gradedToolCallId, verdict },
		isError: false,
		timestamp: 0,
	};
}

describe("repair fold", () => {
	it("a wrong check stays hidden; a correct check on the same node later unlocks it", () => {
		const wrongOnly = repairStateLh([check("c1", "units"), newAnswerResult("c1", "quiz", quizAnswer(false))]);
		assert.equal(checkVerdict(wrongOnly, "c1"), "incorrect");
		assert.equal(checkRevealed(wrongOnly, "c1"), false);

		const unlocked = repairStateLh([
			check("c1", "units"),
			newAnswerResult("c1", "quiz", quizAnswer(false)),
			check("c2", "units"),
			newAnswerResult("c2", "quiz", quizAnswer(true)),
		]);
		assert.equal(checkRevealed(unlocked, "c1"), true);
		assert.equal(checkRevealed(unlocked, "c2"), true);
	});

	it("a correct check on a different node unlocks nothing", () => {
		const state = repairStateLh([
			check("c1", "units"),
			newAnswerResult("c1", "quiz", quizAnswer(false)),
			check("c2", "ropes"),
			newAnswerResult("c2", "quiz", quizAnswer(true)),
		]);
		assert.equal(checkRevealed(state, "c1"), false);
	});

	it("predictions, untagged (probe) quizzes and unknown ids are never hidden", () => {
		const state = repairStateLh([
			check("p1", "units", "quiz", "predict"),
			newAnswerResult("p1", "quiz", quizAnswer(false)),
			call("probe1", "quiz", { question: "old untagged probe" }),
			newAnswerResult("probe1", "quiz", quizAnswer(false)),
		]);
		assert.equal(state.checks.length, 0);
		assert.equal(checkRevealed(state, "p1"), true);
		assert.equal(checkRevealed(state, "probe1"), true);
	});

	it("free recall is ungraded until a grade result names it", () => {
		const base = [check("e1", "units", "explain"), newAnswerResult("e1", "explain", explainAnswer())];
		assert.equal(checkVerdict(repairStateLh(base), "e1"), "ungraded");
		assert.equal(checkRevealed(repairStateLh(base), "e1"), false);

		const partial = repairStateLh([...base, call("g1", "grade", { verdict: "partial" }), gradeResult("g1", "e1", "partial")]);
		assert.equal(checkVerdict(partial, "e1"), "partial");
		assert.equal(checkRevealed(partial, "e1"), false);

		const correct = repairStateLh([...base, call("g1", "grade", { verdict: "correct" }), gradeResult("g1", "e1", "correct")]);
		assert.equal(checkRevealed(correct, "e1"), true);
	});

	it("a reflect call is about the latest answered check before it", () => {
		const state = repairStateLh([
			check("c1", "units"),
			newAnswerResult("c1", "quiz", quizAnswer(false)),
			call("r1", "reflect", { question: "Why?" }),
		]);
		assert.equal(state.reflectTargets.get("r1")?.toolCallId, "c1");
		assert.equal(latestAnsweredCheck(state)?.toolCallId, "c1");
	});

	it("the UI parts fold agrees with the native fold", () => {
		const state = repairStateFromParts([
			{
				parts: [
					{ type: "tool-quiz", toolCallId: "c1", state: "output-available", input: { type: "check", nodeId: "units" }, output: quizAnswer(false) },
					{ type: "tool-reflect", toolCallId: "r1", state: "input-available", input: { question: "Why?" } },
					{ type: "tool-quiz", toolCallId: "c2", state: "output-available", input: { type: "check", nodeId: "units" }, output: quizAnswer(true) },
				],
			},
		]);
		assert.equal(state.reflectTargets.get("r1")?.toolCallId, "c1");
		assert.equal(checkRevealed(state, "c1"), true);
	});
});

describe("reflect and grade tools", () => {
	function chatWith(messages: LhMessage[]): string {
		const chat = chatStore.createChat("Repair tools");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, messages);
		return chat.id;
	}

	it("reflect is refused without a wrong check and allowed after one", async () => {
		const correctChat = chatWith([check("c1", "units"), newAnswerResult("c1", "quiz", quizAnswer(true))]);
		const refused = await reflectToolFor({ chatId: correctChat, chatStore }).execute("r1", { question: "Why?" });
		assert.equal(refused.isError, true);

		const wrongChat = chatWith([check("c1", "units"), newAnswerResult("c1", "quiz", quizAnswer(false))]);
		const allowed = await reflectToolFor({ chatId: wrongChat, chatStore }).execute("r1", { question: "Why?" });
		assert.notEqual(allowed.isError, true);
	});

	it("grade targets the latest ungraded free-recall check, once, and reflect sees it in the same turn", async () => {
		const chatId = chatWith([check("e1", "units", "explain"), newAnswerResult("e1", "explain", explainAnswer())]);
		const turnGrades = new Map();
		const ctx = { chatId, chatStore };

		const ungradedReflect = await reflectToolFor(ctx, new Map()).execute("r0", { question: "Why?" });
		assert.equal(ungradedReflect.isError, true, "reflect must wait for the grade");

		const graded = await gradeToolFor(ctx, turnGrades).execute("g1", { verdict: "incorrect" });
		assert.deepEqual(graded.details, { gradedToolCallId: "e1", verdict: "incorrect" });

		const again = await gradeToolFor(ctx, turnGrades).execute("g2", { verdict: "correct" });
		assert.equal(again.isError, true, "a check is graded once");

		const reflect = await reflectToolFor(ctx, turnGrades).execute("r1", { question: "Why?" });
		assert.notEqual(reflect.isError, true);
	});

	it("grade is refused for a multiple-choice check", async () => {
		const chatId = chatWith([check("c1", "units"), newAnswerResult("c1", "quiz", quizAnswer(false))]);
		const result = await gradeToolFor({ chatId, chatStore }).execute("g1", { verdict: "correct" });
		assert.equal(result.isError, true);
	});
});
