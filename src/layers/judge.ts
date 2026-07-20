/**
 * judge layer — LLM-as-a-judge with votes, weighted rubric, threshold and
 * baseline regression. Subject and judge are independent providers: produce
 * with a paid API in CD, judge with a local model on your machine — or the
 * reverse. Weights are aggregation-side only (never told to the judge — that
 * would bias its scores).
 */
import type {
  CaseCtx,
  CaseDef,
  CaseResult,
  ChatMessage,
  Failure,
  JudgeParams,
  Provider,
  ResolvedLlmInputs,
  RubricItem,
  Scale,
  VoteResult,
} from "../types.js";
import { extractJson, interpolateDeep, resolveRef, truncate } from "../util.js";
import { produceLlm, resolveLlmInputs } from "./llm.js";

const median = (nums: number[]): number => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function buildJudgePrompt({
  context,
  output,
  rubric,
  scale,
}: {
  context: string;
  output: string;
  rubric: Required<RubricItem>[];
  scale: Scale;
}): string {
  const items = rubric.map((r) => `- [${r.id}] ${r.question}`).join("\n");
  return `You are HAECHI, a strict and impartial evaluator of LLM outputs.
Evaluate the RESPONSE UNDER EVALUATION against each rubric item, considering the CONTEXT.
Rules:
- Score every rubric item with an integer from ${scale.min} (completely fails) to ${scale.max} (fully satisfies).
- Judge only what is actually present. Never reward verbosity or politeness.
- Output ONLY one JSON object. No markdown, no code fences, no commentary.
Output format:
{"scores": {"<rubric-id>": <int>, ...}, "reasoning": "<max 3 sentences>"}

[CONTEXT]
${context || "(none)"}

[RESPONSE UNDER EVALUATION]
${output}

[RUBRIC]
${items}`;
}

const renderTranscript = (messages: ChatMessage[]): string =>
  (messages || []).map((m) => `${String(m.role || "user").toUpperCase()}: ${m.content ?? ""}`).join("\n");

interface SubjectOutput {
  output: string;
  context: string;
  resolvedInputs: ResolvedLlmInputs | null;
}

/** Obtain the text to judge + its context. Calls the subject provider only for input: mode. */
async function getSubjectOutput(cs: CaseDef, ctx: CaseCtx): Promise<SubjectOutput> {
  const root = ctx.config.baseDir;
  if (cs.output !== undefined) {
    const output = (await resolveRef(interpolateDeep(cs.output, ctx.lookup), ctx.baseDir, root)) as string;
    const context = cs.context ? ((await resolveRef(cs.context, ctx.baseDir, root)) as string) : "";
    return { output, context, resolvedInputs: null };
  }
  if (cs.transcript) {
    const msgs: ChatMessage[] = cs.transcript.map((m: any) =>
      m.user !== undefined
        ? { role: "user" as const, content: m.user }
        : m.assistant !== undefined
          ? { role: "assistant" as const, content: m.assistant }
          : m
    );
    const lastIdx = msgs.map((m) => m.role).lastIndexOf("assistant");
    return {
      output: (lastIdx >= 0 ? msgs[lastIdx].content : "") ?? "",
      context: renderTranscript(lastIdx >= 0 ? msgs.slice(0, lastIdx) : msgs),
      resolvedInputs: null,
    };
  }
  const subject = ctx.providers[ctx.layer.subject as string];
  const inputs = await resolveLlmInputs(cs.input, ctx);
  const out = await produceLlm(subject, inputs, { maxRounds: cs.input.maxRounds ?? 3 });
  const output = out.lastText || out.text;
  if (!output.trim() && out.unanswered.length)
    throw new Error(
      `the subject called ${out.unanswered.map((t) => `'${t}'`).join(", ")} and is waiting for a tool response, so it never produced text. ` +
        `Add a fixture under input.toolResponses (or set input.params.toolResponseDefault: {} to auto-answer any tool).`
    );
  return {
    output,
    context: renderTranscript(out.transcript.slice(0, -1)),
    resolvedInputs: inputs,
  };
}

async function askJudge(
  judgeProvider: Provider,
  prompt: string,
  rubric: Required<RubricItem>[],
  judgeParams: JudgeParams | undefined
): Promise<{ scores: Record<string, number>; reasoning: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await judgeProvider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: judgeParams?.temperature ?? 0,
      maxTokens: judgeParams?.maxTokens ?? 1024,
      json: true,
    });
    const parsed = extractJson(res.text);
    if (parsed?.scores && rubric.every((r) => typeof parsed.scores[r.id] === "number"))
      return { scores: parsed.scores, reasoning: String(parsed.reasoning || "") };
    prompt += `\n\nREMINDER: your previous output was invalid. Output ONLY the JSON object with a numeric score for every rubric id: ${rubric
      .map((r) => r.id)
      .join(", ")}.`;
  }
  return null;
}

export async function runJudgeCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const judgeProvider = ctx.providers[ctx.layer.judge as string];
  const scale: Scale = { min: 1, max: 10, ...(cs.scale || ctx.layer.scale || {}) };
  const votes = cs.votes ?? ctx.layer.votes ?? 1;
  const rubric: Required<RubricItem>[] = cs.rubric.map((r: RubricItem) => ({ weight: 1, ...r }));

  let subject: SubjectOutput;
  try {
    subject = await getSubjectOutput(cs, ctx);
  } catch (e: any) {
    return { ok: false, failures: [{ path: "subject", message: `producing output failed: ${e.message}` }] };
  }
  if (!String(subject.output).trim())
    return { ok: false, failures: [{ path: "subject", message: "subject produced empty output" }] };

  const prompt = buildJudgePrompt({ context: subject.context, output: subject.output, rubric, scale });
  const voteResults: VoteResult[] = [];
  for (let v = 0; v < votes; v++) {
    try {
      const vote = await askJudge(judgeProvider, prompt, rubric, cs.judgeParams ?? ctx.layer.judgeParams);
      if (vote) {
        const wSum = rubric.reduce((s, r) => s + r.weight, 0);
        const weighted = rubric.reduce((s, r) => s + vote.scores[r.id] * r.weight, 0) / wSum;
        voteResults.push({ ...vote, weighted: Math.round(weighted * 100) / 100 });
      }
    } catch (e: any) {
      failures.push({ path: `vote[${v}]`, message: `judge call failed: ${e.message}` });
    }
  }
  if (!voteResults.length) {
    failures.push({ path: "judge", message: "no valid judge votes (all calls failed or returned unparseable JSON)" });
    return { ok: false, failures };
  }

  const score = median(voteResults.map((v) => v.weighted));
  const threshold = cs.threshold ?? ctx.layer.threshold;
  if (threshold !== undefined && score < threshold)
    failures.push({ path: "score", message: `median ${score} below threshold ${threshold}` });

  for (const [id, min] of Object.entries((cs.minScores as Record<string, number>) || {})) {
    const vals = voteResults.map((v) => v.scores[id]).filter((n) => typeof n === "number");
    const mean = vals.reduce((s, n) => s + n, 0) / (vals.length || 1);
    if (mean < min)
      failures.push({ path: `minScores.${id}`, message: `mean ${Math.round(mean * 100) / 100} below ${min}` });
  }

  // baseline regression is applied by the runner (it owns the baseline file)
  return {
    ok: !failures.length,
    failures,
    score,
    scale,
    votes: voteResults.map((v) => ({ ...v, reasoning: truncate(v.reasoning, 240) })),
    output: truncate(subject.output, 600),
    resolvedInputs: subject.resolvedInputs,
  };
}
