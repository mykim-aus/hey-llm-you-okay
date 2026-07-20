/**
 * judge layer — LLM-as-a-judge that reports how much it can be trusted.
 *
 * Measured on a real case (2026-07): asking a judge about a fuzzy SURFACE
 * property ("does the response leak English?") produced scores of 2, 3, 8, 9,
 * 9 and 10 for the SAME rubric item — a threshold gate on that is a coin flip.
 * Re-asking the same case as REQUEST FULFILMENT ("did it do what was asked,
 * consistently with the context?") cut the spread from 8 to 3, and two votes
 * on one output became identical.
 *
 * So this layer does three things no score-only judge does:
 *   1. `ask: binary` + `citeSpan` — remove the grey zone, and verify the quoted
 *      evidence actually exists in the output (fabricated evidence is dropped).
 *   2. Measure per-item vote agreement and report it.
 *   3. When the judges disagree beyond `reliability.maxSpread`, refuse to
 *      return a verdict at all — INCONCLUSIVE. Saying "I cannot tell" is
 *      better than a coin-flip pass.
 *
 * Subject and judge are independent providers: produce with a paid API in CD,
 * judge with a local CLI on your machine — or the reverse.
 */
import type {
  AgreementReport,
  CaseCtx,
  CaseDef,
  CaseResult,
  ChatMessage,
  Failure,
  JudgeParams,
  Provider,
  ReliabilityConfig,
  ResolvedLlmInputs,
  RubricItem,
  Scale,
  VoteResult,
} from "../types.js";
import { extractJson, interpolateDeep, resolveRef, truncate } from "../util.js";
import { produceLlm, resolveLlmInputs } from "./llm.js";

type FullRubric = RubricItem & { weight: number; ask: "scale" | "binary" };

const median = (nums: number[]): number => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildJudgePrompt({
  context,
  output,
  rubric,
  scale,
}: {
  context: string;
  output: string;
  rubric: FullRubric[];
  scale: Scale;
}): string {
  const binary = rubric.filter((r) => r.ask === "binary");
  const scaled = rubric.filter((r) => r.ask !== "binary");
  const cited = rubric.filter((r) => r.citeSpan);

  const lines: string[] = [];
  for (const r of rubric)
    lines.push(`- [${r.id}] (${r.ask === "binary" ? "yes/no" : `${scale.min}-${scale.max}`}) ${r.question}`);

  const rules = [
    `- Judge ONLY what is present in the response. Never reward length, politeness or effort.`,
    scaled.length
      ? `- For ${scale.min}-${scale.max} items, score how fully the response satisfies the item.`
      : "",
    binary.length
      ? `- For yes/no items, answer true when the response SATISFIES the item and false when it does not. Do not hedge — pick one.`
      : "",
    cited.length
      ? `- For these items you MUST quote evidence in "spans", copied VERBATIM from the response (a short exact substring): ${cited
          .map((r) => r.id)
          .join(", ")}. Quote the text that made you answer the way you did. Never paraphrase or invent a quote.`
      : "",
    `- Output ONLY one JSON object. No markdown, no code fences, no commentary.`,
  ].filter(Boolean);

  const shape = [
    `"scores": {${rubric
      .map((r) => `"${r.id}": ${r.ask === "binary" ? "true|false" : `<int ${scale.min}-${scale.max}>`}`)
      .join(", ")}}`,
    cited.length ? `"spans": {${cited.map((r) => `"${r.id}": "<exact quote>"`).join(", ")}}` : "",
    `"reasoning": "<max 3 sentences>"`,
  ].filter(Boolean);

  return `You are an impartial evaluator of LLM outputs.
Evaluate the RESPONSE UNDER EVALUATION against each rubric item, in light of the CONTEXT.
Rules:
${rules.join("\n")}
Output format:
{${shape.join(", ")}}

[CONTEXT]
${context || "(none)"}

[RESPONSE UNDER EVALUATION]
${output}

[RUBRIC]
${lines.join("\n")}`;
}

const renderTranscript = (messages: ChatMessage[]): string =>
  (messages || []).map((m) => `${String(m.role || "user").toUpperCase()}: ${m.content ?? ""}`).join("\n");

interface SubjectOutput {
  output: string;
  context: string;
  resolvedInputs: ResolvedLlmInputs | null;
}

/** Obtain the text to judge + its context. Calls the subject only for `input:`. */
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
  return { output, context: renderTranscript(out.transcript.slice(0, -1)), resolvedInputs: inputs };
}

/** Normalize a raw judge answer into numeric scores; drop unverifiable evidence. */
function normalizeVote(
  parsed: any,
  rubric: FullRubric[],
  scale: Scale,
  output: string
): { scores: Record<string, number>; spans: Record<string, string>; reasoning: string } | null {
  const scores: Record<string, number> = {};
  const spans: Record<string, string> = {};
  for (const r of rubric) {
    const raw = parsed?.scores?.[r.id];
    if (r.ask === "binary") {
      const v = typeof raw === "boolean" ? raw : typeof raw === "string" ? /^(true|yes|pass)$/i.test(raw) : null;
      if (v === null) return null;
      scores[r.id] = v ? scale.max : scale.min;
    } else {
      if (typeof raw !== "number") return null;
      scores[r.id] = Math.min(scale.max, Math.max(scale.min, raw));
    }
    if (r.citeSpan) {
      const quote = String(parsed?.spans?.[r.id] ?? "").trim();
      // Evidence that is not actually in the output is a hallucination. Keep
      // the vote but record the span as unverified so the report can show it.
      if (quote && output.includes(quote)) spans[r.id] = quote;
      else if (quote) spans[r.id] = `⚠ not found in output: ${truncate(quote, 60)}`;
    }
  }
  return { scores, spans, reasoning: String(parsed?.reasoning || "") };
}

async function askJudge(
  judgeProvider: Provider,
  basePrompt: string,
  rubric: FullRubric[],
  scale: Scale,
  output: string,
  judgeParams: JudgeParams | undefined
): Promise<{ scores: Record<string, number>; spans: Record<string, string>; reasoning: string } | null> {
  let prompt = basePrompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    // temperature 0 by default (determinism); `temperature: null` omits the
    // parameter for models that reject sampling params entirely.
    const temperature =
      judgeParams && "temperature" in judgeParams ? (judgeParams.temperature ?? undefined) : 0;
    const res = await judgeProvider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature,
      maxTokens: judgeParams?.maxTokens ?? 1024,
      json: true,
    });
    const vote = normalizeVote(extractJson(res.text), rubric, scale, output);
    if (vote) return vote;
    prompt = `${basePrompt}\n\nREMINDER: your previous output was invalid. Output ONLY the JSON object, with an answer for EVERY rubric id: ${rubric
      .map((r) => r.id)
      .join(", ")}.`;
  }
  return null;
}

/** Per-item and overall vote spread — the trustworthiness of this verdict. */
export function computeAgreement(votes: VoteResult[], rubric: FullRubric[]): AgreementReport {
  const perItem: AgreementReport["perItem"] = {};
  let worstItem: string | null = null;
  let worst = -1;
  for (const r of rubric) {
    const vals = votes.map((v) => v.scores[r.id]).filter((n) => typeof n === "number");
    if (!vals.length) continue;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    perItem[r.id] = { min, max, spread: round2(max - min) };
    if (max - min > worst) {
      worst = max - min;
      worstItem = r.id;
    }
  }
  const weighted = votes.map((v) => v.weighted);
  return {
    spread: round2(Math.max(...weighted) - Math.min(...weighted)),
    perItem,
    worstItem: worst > 0 ? worstItem : null,
  };
}

export async function runJudgeCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const judgeProvider = ctx.providers[ctx.layer.judge as string];
  const scale: Scale = { min: 1, max: 10, ...(cs.scale || ctx.layer.scale || {}) };
  const votes = cs.votes ?? ctx.layer.votes ?? 1;
  const rubric: FullRubric[] = cs.rubric.map((r: RubricItem) => ({ weight: 1, ask: "scale", ...r }));
  const reliability: ReliabilityConfig = {
    maxSpread: Math.round((scale.max - scale.min) * 0.35 * 100) / 100, // 1-10 → 3.15
    enforce: true,
    ...(ctx.layer.reliability || {}),
    ...(cs.reliability || {}),
  };

  let subject: SubjectOutput;
  try {
    subject = await getSubjectOutput(cs, ctx);
  } catch (e: any) {
    return { ok: false, failures: [{ path: "subject", message: `producing output failed: ${e.message}` }] };
  }
  if (!String(subject.output).trim())
    return { ok: false, failures: [{ path: "subject", message: "subject produced empty output" }] };

  const prompt = buildJudgePrompt({ context: subject.context, output: subject.output, rubric, scale });
  const wSum = rubric.reduce((s, r) => s + r.weight, 0);
  const voteResults: VoteResult[] = [];
  for (let v = 0; v < votes; v++) {
    try {
      const vote = await askJudge(
        judgeProvider,
        prompt,
        rubric,
        scale,
        subject.output,
        cs.judgeParams ?? ctx.layer.judgeParams
      );
      if (vote) {
        const weighted = rubric.reduce((s, r) => s + vote.scores[r.id] * r.weight, 0) / wSum;
        voteResults.push({
          scores: vote.scores,
          reasoning: truncate(vote.reasoning, 240),
          weighted: round2(weighted),
          ...(Object.keys(vote.spans).length ? { spans: vote.spans } : {}),
        });
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
  const agreement = computeAgreement(voteResults, rubric);
  const base = { score, scale, votes: voteResults, agreement, output: truncate(subject.output, 600), resolvedInputs: subject.resolvedInputs };

  // ── the trust gate ───────────────────────────────────────────────
  // If the judges cannot reproduce each other, the score is noise. Refuse to
  // return a verdict rather than flip a coin. A gated layer fails closed.
  if (
    reliability.enforce !== false &&
    voteResults.length > 1 &&
    reliability.maxSpread !== undefined &&
    agreement.spread > reliability.maxSpread
  ) {
    const worst = agreement.worstItem;
    const detail = worst ? ` worst item '${worst}' ranged ${agreement.perItem[worst].min}–${agreement.perItem[worst].max}.` : "";
    return {
      ...base,
      ok: !ctx.layer.gate, // gated layer fails closed; otherwise report loudly
      inconclusive:
        `judges disagreed by ${agreement.spread} (> maxSpread ${reliability.maxSpread}) across ${voteResults.length} votes.${detail} ` +
        `The score is not trustworthy, so no verdict was issued — tighten the rubric (ask: binary, citeSpan) or raise votes.`,
      failures,
    };
  }

  const threshold = cs.threshold ?? ctx.layer.threshold;
  if (threshold !== undefined && score < threshold)
    failures.push({ path: "score", message: `median ${score} below threshold ${threshold}` });

  for (const [id, min] of Object.entries((cs.minScores as Record<string, number>) || {})) {
    const vals = voteResults.map((v) => v.scores[id]).filter((n) => typeof n === "number");
    const mean = vals.reduce((s, n) => s + n, 0) / (vals.length || 1);
    if (mean < min) failures.push({ path: `minScores.${id}`, message: `mean ${round2(mean)} below ${min}` });
  }

  // baseline regression is applied by the runner (it owns the baseline file)
  return { ...base, ok: !failures.length, failures };
}
