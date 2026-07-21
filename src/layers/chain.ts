/**
 * chain layer — run one input through ORDERED real-backend stages, and when the
 * final assertion fails, ATTRIBUTE which stage is the culprit by counterfactual
 * substitution.
 *
 * WHY THIS EXISTS: observability answers WHAT happened, evaluation answers
 * WHETHER it passed — neither answers WHICH stage caused the failure. The stage
 * that surfaces the bad output is usually not the stage that DECIDED wrong (a
 * model emits a vague sentence → a retriever grounds it to the wrong record →
 * the UI shows it: the retriever is blamed, the prompt is the fault). LLM-judge-
 * on-trace attribution is ~14% accurate at the step level (Who&When benchmark).
 *
 * HOW: a minimal Causal Agent Replay (arXiv 2606.08275). The one irreducibly
 * nondeterministic input — a model call — is what a stage RECORDS as its output;
 * every downstream stage is deterministic glue we RE-EXECUTE. On failure, for
 * each stage that declares a `golden` (its known-good output for this case), we
 * force that stage's output to golden, re-run everything downstream for real,
 * and check whether the outcome recovers. The SMALLEST stage whose fix recovers
 * is the decision point — the culprit — not the symptom.
 *
 * STAGE CONTRACT (exec): the command reads the previous stage's output as JSON
 * on stdin and writes this stage's output as JSON on stdout. Stage 1 reads
 * `input`. Stages stay app-specific scripts; the chain layer is generic glue.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { applyExpect } from "../assert.js";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";

interface StageDef {
  name: string;
  run: string;
  golden?: unknown;
}
interface StageTrace {
  name: string;
  input: unknown;
  output: unknown;
}

// Shared with the exec layer: a stage that says "I could not measure" (rate
// limited, backend down) is INFRA, never a failing test.
const INFRA_EXIT = 97;

function spawnJson(
  cmd: string,
  stdin: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, timeoutMs);
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

class InfraError extends Error {}

async function runStage(stage: StageDef, input: unknown, cwd: string, timeoutMs: number): Promise<unknown> {
  if (typeof stage.run !== "string" || !stage.run.startsWith("exec:"))
    throw new Error(`stage '${stage.name}': run must be an 'exec:' ref (got ${JSON.stringify(stage.run)})`);
  const cmd = stage.run.slice(5).trim();
  const r = await spawnJson(cmd, JSON.stringify(input ?? null), cwd, timeoutMs);
  if (r.timedOut) throw new Error(`stage '${stage.name}' timed out after ${timeoutMs}ms`);
  if (r.code === INFRA_EXIT) throw new InfraError(`stage '${stage.name}' could not measure: ${(r.stderr || r.stdout).trim().slice(-200)}`);
  if (r.code !== 0) throw new Error(`stage '${stage.name}' exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`stage '${stage.name}' did not emit JSON on stdout: ${r.stdout.slice(0, 200)}`);
  }
}

/** Run stages [from..end] with `val` as the input to stage `from`, recording a trace. */
async function runFrom(
  stages: StageDef[],
  from: number,
  val: unknown,
  cwd: string,
  timeoutMs: number,
  trace: StageTrace[]
): Promise<unknown> {
  let cur = val;
  for (let i = from; i < stages.length; i++) {
    const out = await runStage(stages[i], cur, cwd, timeoutMs);
    trace.push({ name: stages[i].name, input: cur, output: out });
    cur = out;
  }
  return cur;
}

const finalPasses = (expect: Record<string, unknown> | undefined, final: unknown): boolean => {
  const f: Failure[] = [];
  applyExpect(expect ?? {}, { json: final, text: JSON.stringify(final) }, f);
  return f.length === 0;
};

function renderTrace(trace: StageTrace[]): string {
  return trace
    .map((t, i) => `  [${i + 1}] ${t.name}: ${JSON.stringify(t.input)} → ${JSON.stringify(t.output)}`)
    .join("\n");
}

/**
 * Counterfactual attribution: force each golden-bearing stage's output to golden,
 * re-run downstream, and report the smallest stage whose fix recovers the outcome.
 */
async function attribute(
  stages: StageDef[],
  cs: CaseDef,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  const lines: string[] = ["── HOP ATTRIBUTION (counterfactual — force stage=golden, re-run downstream) ──"];
  let anyGolden = false;
  for (let k = 0; k < stages.length; k++) {
    if (stages[k].golden === undefined) continue;
    anyGolden = true;
    try {
      const finalCF = await runFrom(stages, k + 1, stages[k].golden, cwd, timeoutMs, []);
      const recovers = finalPasses(cs.expect, finalCF);
      lines.push(`  force ${stages[k].name}=golden → downstream real → ${recovers ? "RECOVERS ✓" : "still fails"}`);
      if (recovers) {
        lines.push(
          `\n  🔴 CULPRIT = stage '${stages[k].name}' (or its input). Forcing only this stage's output to its ` +
            `known-good recovers the final outcome, so the wrong DECISION was made at or above here — ` +
            `not merely surfaced downstream. Fix this stage.`
        );
        return lines.join("\n");
      }
    } catch (e: any) {
      lines.push(`  force ${stages[k].name}=golden → downstream real → error: ${e.message}`);
    }
  }
  if (!anyGolden)
    lines.push("  (no stage declared `golden:` — add known-good outputs to enable automatic attribution)");
  else
    lines.push(
      "\n  (no single golden substitution recovered the outcome — the fault is compound, or below the last stage with a golden)"
    );
  return lines.join("\n");
}

export async function runChainCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const stages: StageDef[] = Array.isArray(cs.stages) ? cs.stages : [];
  const cwd = cs.cwd ? path.resolve(ctx.baseDir, cs.cwd) : ctx.baseDir;
  const timeoutMs = cs.timeoutMs ?? 120000;
  if (!stages.length) return { ok: false, failures: [{ path: "stages", message: "a chain case needs at least one stage" }] };

  const trace: StageTrace[] = [];
  let final: unknown;
  try {
    final = await runFrom(stages, 0, cs.input ?? null, cwd, timeoutMs, trace);
  } catch (e: any) {
    const infra = e instanceof InfraError;
    return {
      ok: false,
      failures: [{ path: `stage:${trace.length < stages.length ? stages[trace.length].name : "?"}`, message: e.message, infra }],
      outputTail: renderTrace(trace),
    };
  }

  const failures: Failure[] = [];
  applyExpect(cs.expect ?? {}, { json: final, text: JSON.stringify(final) }, failures);
  if (!failures.length)
    return { ok: true, failures: [], detail: { stages: stages.length }, outputTail: undefined };

  // Failed → run the counterfactual attribution and attach it under the trace.
  const attribution = await attribute(stages, cs, cwd, timeoutMs);
  return {
    ok: false,
    failures,
    detail: { stages: stages.length },
    outputTail: `${renderTrace(trace)}\n\n${attribution}`,
  };
}
