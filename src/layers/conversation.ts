/**
 * conversation layer — drive a real conversational endpoint over N turns, then
 * JUDGE the whole transcript against a rubric.
 *
 * `scenario` drives the same multi-turn HTTP flow but asserts each turn
 * DETERMINISTICALLY (status/JSON). `conversation` is for what a matcher cannot
 * express: does the whole exchange stay coherent, never contradict an earlier
 * turn, never misattribute? It reuses the judge machinery (votes, run-axis
 * reliability, --changed-only), so with `--profile claude-judge` the local Claude
 * CLI grades the transcript. Warn-only by default (model-graded), like `judge`.
 *
 *   kind: conversation
 *   judge: judge                       # the LLM-as-a-judge provider (layer-level)
 *   cases:
 *     - name: study-flow-stays-coherent
 *       request: { url: "{{BASE}}/api/talk", headers: { Cookie: "s={{TOKEN}}" } }
 *       body: { locale: en, mode: study }
 *       replyPath: data.reply
 *       turns:
 *         - { user: "start case 2" }        # optional per-turn deterministic expect too
 *         - { user: "I understand it now" }
 *       rubric:
 *         - { id: coherent, question: "Does each reply follow naturally from the prior turn?", ask: binary }
 *         - { id: attribution, question: "Does it never credit the learner with a correction the assistant itself gave?", ask: binary }
 *       threshold: 7
 */
import type { CaseCtx, CaseDef, CaseResult, ChatMessage } from "../types.js";
import { driveConversation } from "./scenario.js";
import { runJudgeCase } from "./judge.js";

const renderTranscript = (msgs: ChatMessage[]): string =>
  msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content ?? ""}`).join("\n");

export async function runConversationCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  // 1. drive the real endpoint over the turns — deterministic per-turn checks
  //    (status<400 by default) + the transcript to judge.
  const { transcript, failures: driveFailures, turns } = await driveConversation(cs, ctx);
  // A transport failure (fetch threw) means there is no transcript to judge —
  // report it directly rather than judging an empty conversation.
  if (!transcript.length || driveFailures.some((f) => (f.path || "").endsWith(".request"))) {
    return { ok: false, failures: driveFailures, detail: { turns } };
  }
  // 2. judge the WHOLE transcript with the rubric, reusing runJudgeCase (an
  //    `output:` case). --profile claude-judge → the local Claude CLI grades it.
  const judged = await runJudgeCase(
    {
      name: cs.name,
      output: renderTranscript(transcript),
      context: cs.context,
      rubric: cs.rubric,
      threshold: cs.threshold,
      votes: cs.votes,
      scale: cs.scale,
      reliability: cs.reliability,
      judgeParams: cs.judgeParams,
    },
    ctx
  );
  // 3. a per-turn deterministic failure fails the case regardless of the score.
  return {
    ...judged,
    failures: [...driveFailures, ...judged.failures],
    ok: judged.ok && !driveFailures.length,
    detail: { ...(judged.detail || {}), turns },
  };
}
