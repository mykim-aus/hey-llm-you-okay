/**
 * Automated Triage Protocol — the AI-specific failure adjudication engine.
 *
 * A failing LLM test has three fundamentally different causes, each demanding
 * a different human action:
 *
 *   flaky        sampling noise            → tune repeat/passRate, not code
 *   your-change  your prompt/config broke  → fix the diff
 *   model-drift  provider updated model    → re-baseline or adapt prompts
 *
 * The probe distinguishes them with an isolated A/B re-run under TODAY's
 * model:
 *
 *   arm A (current):  the failing case's inputs as resolved right now
 *   arm B (snapshot): the inputs that last PASSED (from .haechi/baseline.json
 *                     snapshots, or the prompt files at a git ref)
 *
 * Each arm runs `repeat` times (default 3):
 *   A mostly passes             → flaky        (the original failure was noise)
 *   A fails, B mostly passes    → your-change  (old inputs still work today)
 *   A fails, B fails            → model-drift  (nothing you wrote fixes it)
 *   provider/model differs      → config-changed
 *   anything in between         → inconclusive
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadBaseline, caseKey } from "./baseline.js";
import { buildJudgePrompt } from "./layers/judge.js";
import { checkLlmExpect, produceLlm, resolveLlmInputs } from "./layers/llm.js";
import type {
  CaseCtx,
  CaseRunRecord,
  Failure,
  HaechiConfig,
  LayerConfig,
  Provider,
  ResolvedLlmInputs,
  TriageArm,
  TriageReport,
} from "./types.js";
import { extractJson } from "./util.js";

const pExecFile = promisify(execFile);

/** Fetch a file's content at a git ref (for `source: git` old-arm resolution). */
async function gitShow(baseDir: string, ref: string, absPath: string): Promise<string | null> {
  try {
    const { stdout: top } = await pExecFile("git", ["rev-parse", "--show-toplevel"], { cwd: baseDir });
    const rel = path.relative(top.trim(), absPath);
    if (rel.startsWith("..")) return null;
    const { stdout } = await pExecFile("git", ["show", `${ref}:${rel}`], {
      cwd: baseDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Build the "old" inputs for the git source: re-resolve the case, but with
 * every file: ref read from the git ref instead of the working tree.
 */
async function resolveInputsAtGitRef(
  def: Record<string, any>,
  ctx: CaseCtx,
  ref: string
): Promise<ResolvedLlmInputs | null> {
  const fileFields = ["system", "tools"];
  const overridden: Record<string, any> = { ...def };
  let touchedAny = false;
  for (const field of fileFields) {
    const v = def[field];
    if (typeof v === "string" && v.startsWith("file:")) {
      const abs = path.resolve(ctx.baseDir, v.slice(5));
      const old = await gitShow(ctx.baseDir, ref, abs);
      if (old === null) return null; // file not in git at that ref — can't build the old arm
      overridden[field] = /\.json$/i.test(abs) ? JSON.parse(old) : old;
      touchedAny = true;
    }
  }
  if (!touchedAny) return null; // nothing file-based changed — git arm is meaningless
  return resolveLlmInputs(overridden, ctx);
}

/** Run one arm: repeat× the case's checks against given inputs. */
async function runArm(
  label: TriageArm["label"],
  record: CaseRunRecord,
  layer: LayerConfig,
  ctx: CaseCtx,
  inputs: ResolvedLlmInputs,
  repeat: number
): Promise<TriageArm> {
  let passed = 0;
  const failures: Failure[] = [];
  for (let i = 0; i < repeat; i++) {
    const fs: Failure[] = [];
    try {
      if (layer.kind === "llm") {
        const provider = ctx.providers[layer.provider as string];
        const out = await produceLlm(provider, inputs, {
          maxRounds: record.def.maxRounds ?? 3,
          perTurnFailures: fs,
        });
        const text = out.lastText || out.text;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {}
        checkLlmExpect(
          record.def.expect,
          { text, fullText: out.text, json, toolCalls: out.toolCalls, toolNames: out.toolCalls.map((c) => c.name) },
          fs
        );
      } else {
        // judge: produce with subject from these inputs, then single-vote judge
        const subject = ctx.providers[layer.subject as string];
        const judge = ctx.providers[layer.judge as string];
        const out = await produceLlm(subject, inputs, { maxRounds: record.def.input?.maxRounds ?? 3 });
        const output = out.lastText || out.text;
        const rubric = (record.def.rubric || []).map((r: any) => ({ weight: 1, ...r }));
        const scale = { min: 1, max: 10, ...(record.def.scale || layer.scale || {}) };
        const prompt = buildJudgePrompt({
          context: out.transcript
            .slice(0, -1)
            .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
            .join("\n"),
          output,
          rubric,
          scale,
        });
        // honour the case/layer judgeParams — triage must not hardcode
        // sampling params the configured model may reject
        const jp = record.def.judgeParams ?? layer.judgeParams;
        const res = await judge.chat({
          messages: [{ role: "user", content: prompt }],
          temperature: jp && "temperature" in jp ? (jp.temperature ?? undefined) : 0,
          maxTokens: jp?.maxTokens ?? 1024,
          json: true,
        });
        const parsed = extractJson(res.text);
        if (!parsed?.scores) {
          fs.push({ path: "judge", message: "unparseable judge vote" });
        } else {
          const wSum = rubric.reduce((s: number, r: any) => s + r.weight, 0);
          const weighted =
            rubric.reduce((s: number, r: any) => s + (parsed.scores[r.id] ?? scale.min) * r.weight, 0) / wSum;
          const threshold = record.def.threshold ?? layer.threshold;
          if (threshold !== undefined && weighted < threshold)
            fs.push({ path: "score", message: `arm score ${Math.round(weighted * 100) / 100} below threshold ${threshold}` });
        }
      }
    } catch (e: any) {
      fs.push({ path: "provider", message: e.message });
    }
    if (!fs.length) passed++;
    else if (!failures.length) failures.push(...fs.slice(0, 3));
  }
  return { label, passed, attempts: repeat, failures };
}

const rate = (arm: TriageArm) => arm.passed / arm.attempts;

function verdictOf(current: TriageArm, snapshot: TriageArm | null): { verdict: TriageReport["verdict"]; reason: string } {
  const HIGH = 2 / 3;
  const LOW = 1 / 3;
  if (rate(current) >= HIGH)
    return {
      verdict: "flaky",
      reason: `isolated re-run passes ${current.passed}/${current.attempts} — the original failure was sampling noise; consider repeat/passRate`,
    };
  if (!snapshot)
    return {
      verdict: "no-snapshot",
      reason: "no last-passing snapshot or git history for the old arm — run once green (or commit prompts) to enable A/B triage",
    };
  if (rate(current) <= LOW && rate(snapshot) >= HIGH)
    return {
      verdict: "your-change",
      reason: `old inputs still pass ${snapshot.passed}/${snapshot.attempts} under today's model while current fail ${current.attempts - current.passed}/${current.attempts} — the diff between them broke it`,
    };
  if (rate(current) <= LOW && rate(snapshot) <= LOW)
    return {
      verdict: "model-drift",
      reason: `BOTH current and last-passing inputs now fail (${current.passed}/${current.attempts} vs ${snapshot.passed}/${snapshot.attempts}) — the provider's model behavior changed; re-baseline or adapt`,
    };
  return {
    verdict: "inconclusive",
    reason: `mixed pass rates (current ${current.passed}/${current.attempts}, snapshot ${snapshot.passed}/${snapshot.attempts}) — increase triage repeat for a sharper signal`,
  };
}

/** Triage every failed llm/judge case of a finished run. */
export async function triageFailures(
  config: HaechiConfig,
  providers: Record<string, Provider>,
  failed: Array<{ layer: LayerConfig; record: CaseRunRecord }>,
  makeCtx: (layer: LayerConfig, baseDir: string) => CaseCtx,
  log: (line: string) => void
): Promise<TriageReport[]> {
  const settings = config.settings.triage || {};
  const repeat = settings.repeat ?? 3;
  const gitRef = settings.gitRef ?? "HEAD";
  const baseline = await loadBaseline(config.baseDir);
  const reports: TriageReport[] = [];

  for (const { layer, record } of failed) {
    if (layer.kind !== "llm" && layer.kind !== "judge") continue;
    const key = caseKey(layer.name, record.name);
    const ctx = makeCtx(layer, record.baseDir);
    const providerName = (layer.kind === "llm" ? layer.provider : layer.subject) as string;
    const currentModel = providers[providerName]?.model;
    log(`triage ${key} — isolating and A/B probing (${repeat}× per arm)…`);

    // judge cases without a live subject (output:/transcript:) can't be replayed
    if (layer.kind === "judge" && !record.def.input) {
      reports.push({
        layer: layer.name,
        caseName: record.name,
        verdict: "no-snapshot",
        reason: "judge case has static output/transcript — nothing to re-produce; check the judge/threshold instead",
      });
      continue;
    }

    // current arm inputs — resolved fresh from the working tree.
    // A broken file:/exec: ref must degrade to one report, never abort the run
    // (the summary and CI report would be lost).
    const defForInputs = layer.kind === "llm" ? record.def : record.def.input;
    let currentInputs;
    try {
      currentInputs = await resolveLlmInputs(defForInputs, ctx);
    } catch (e: any) {
      reports.push({
        layer: layer.name,
        caseName: record.name,
        verdict: "inconclusive",
        reason: `could not resolve the case inputs for triage: ${e.message}`,
      });
      continue;
    }
    const current = await runArm("current", record, layer, ctx, currentInputs, repeat);

    // early exit: isolated re-run passes → flaky, don't burn the old arm
    if (rate(current) >= 2 / 3) {
      const { verdict, reason } = verdictOf(current, null);
      reports.push({ layer: layer.name, caseName: record.name, verdict, reason, arms: [current] });
      continue;
    }

    // old arm: snapshot store first, git fallback (or forced via settings.source)
    const snap = baseline.snapshots[key];

    // diff shortcut — inputs IDENTICAL to the last-passing snapshot mean the
    // failure cannot be "your change"; skip the B arm entirely (zero extra cost)
    if (snap && JSON.stringify(snap.inputs) === JSON.stringify(currentInputs)) {
      reports.push({
        layer: layer.name,
        caseName: record.name,
        verdict: "model-drift",
        reason: `inputs are byte-identical to the last-passing snapshot (${snap.at}) yet now fail ${current.attempts - current.passed}/${current.attempts} — nothing on your side changed; the provider's model behavior did`,
        arms: [current],
        model: { snapshot: snap.model, current: currentModel },
      });
      continue;
    }

    let oldInputs: ResolvedLlmInputs | null = null;
    let oldSource = "";
    if (settings.source !== "git" && snap) {
      oldInputs = snap.inputs;
      oldSource = `snapshot@${snap.at}`;
      if (snap.model && currentModel && snap.model !== currentModel) {
        reports.push({
          layer: layer.name,
          caseName: record.name,
          verdict: "config-changed",
          reason: `provider model changed since snapshot (${snap.model} → ${currentModel}) — the comparison target moved; re-baseline intentionally`,
          model: { snapshot: snap.model, current: currentModel },
          arms: [current],
        });
        continue;
      }
    }
    if (!oldInputs) {
      oldInputs = await resolveInputsAtGitRef(defForInputs, ctx, gitRef);
      oldSource = oldInputs ? `git@${gitRef}` : "";
    }
    const snapshotArm = oldInputs ? await runArm("snapshot", record, layer, ctx, oldInputs, repeat) : null;

    const { verdict, reason } = verdictOf(current, snapshotArm);
    reports.push({
      layer: layer.name,
      caseName: record.name,
      verdict,
      reason: oldSource ? `${reason} [old arm: ${oldSource}]` : reason,
      arms: snapshotArm ? [current, snapshotArm] : [current],
      model: { snapshot: snap?.model, current: currentModel },
    });
  }
  return reports;
}
