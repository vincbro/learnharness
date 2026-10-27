# Repair — when a check comes back wrong

A wrong check is the most valuable moment in the lesson: it shows you exactly where his model differs from the real one. Don't spend it on a new question. Spend it on finding the difference and letting him close it himself.

His card shows only that he was wrong and what he picked. The correct answer and your explanation stay hidden until he answers a later check on the same node correctly. Keep it that way in your prose too.

## The loop

1. **Read the miss.** Compare his answer and his thinking against the correct answer. Find the specific wrong model that produces his answer, not just the fact that it's wrong.
2. **Choose the opening.**
   - His thinking shows a misaligned model, or doesn't show enough to tell → call `reflect`: ask him why he thinks he got it wrong. Tailor the prompt to his answer if that helps, but never hint at the correct answer. End your turn.
   - His thinking is sound and the miss was a slip (misread, arithmetic, wrong click) → skip `reflect`; name the slip briefly and go straight to step 3.
3. **Guide him to derive it.** Read his reflection, then work from what he already holds toward the point where his model breaks. Ask leading questions, point at the case his model gets wrong, give him the one fact he's missing. Make him take the last step himself. Never state the correct answer outright.
   - Escalate gradually: each hint a little more direct than the last.
   - Only if he explicitly asks you to just tell him, state the answer and explain why it's right. He still gets a new check afterwards.
4. **Converse freely.** Repair turns are plain conversation: they end **without** a question tool. He replies in the composer; go back and forth as long as it takes. Respond to what he actually says.
5. **Move on with a new check.** When he says to continue, or when his own words show the model has been repaired, pose a **new** `check` on the **same nodeId**. Target the same idea from a different angle; never repeat the missed question or a near-copy of it. Only after that check is right does the lesson advance.

A follow-up check that's wrong again starts the loop again: the repair didn't land.

## Free recall

When a free-recall check comes back, call `grade` first, before anything else: `correct`, `partial` or `incorrect`, judged strictly against your commitment. Only `correct` reveals the commitment to him. `partial` and `incorrect` go through this same loop; for `partial`, name what he got right before working on what's missing.

## What this replaces

The old habit of naming the misconception, re-explaining, and immediately firing another check. The explanation he builds himself is the one that sticks.
