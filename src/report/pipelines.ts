/**
 * Pipeline dashboard — `heyllm pipelines`. Answers three questions at a glance:
 *   what pipelines exist · how they flow (the gated pyramid) · how the last run went.
 * Plus the triage info that makes it actionable: WHICH cases failed, per-stage
 * token spend, per-stage age (honest when a filtered run refreshed only some
 * stages), and which cases are flaky across runs.
 * Pure rendering: takes the config's stages + the persisted last run, returns lines.
 */
import type { LayerKind, RunSummary } from "../types.js";
import { c, ms } from "../util.js";

export interface PipelineStage {
  name: string;
  kind: LayerKind;
  gate: boolean;
  count: number;
  tags: string[];
  driver?: string; // provider / subject+judge, for llm/judge stages
}

export interface PipelineOpts {
  verbose?: boolean;
  /** age of the most recent run overall (banner) */
  ageMs?: number;
  /** per-stage age (ms) — a filtered run refreshes only some stages */
  stageAgeMs?: Record<string, number>;
  /** case names flagged flaky (flip pass/fail across runs), per stage */
  flaky?: Record<string, string[]>;
}

/** One stage's last-run rollup, or null if it did not run last time. */
interface StageRun {
  passed: number;
  failed: number;
  skipped: number;
  cached: number;
  inconclusive: number;
  total: number;
  ok: boolean;
  durationMs: number;
  halted: boolean;
  failedNames: string[];
  tokens: number; // input+output floor, 0 if no model calls
  ageMs?: number;
  flaky: string[];
}

const relTime = (ageMs: number): string => {
  if (ageMs < 0) return "just now";
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

function rollup(summary: RunSummary | null, name: string, opts: PipelineOpts): StageRun | null {
  if (!summary) return null;
  const base = {
    passed: 0, failed: 0, skipped: 0, cached: 0, inconclusive: 0, total: 0,
    failedNames: [] as string[], tokens: 0, ageMs: opts.stageAgeMs?.[name], flaky: opts.flaky?.[name] ?? [],
  };
  if (summary.halted?.includes(name)) return { ...base, ok: false, durationMs: 0, halted: true };
  const layer = summary.layers.find((l) => l.name === name);
  if (!layer) return null;
  const cs = layer.cases;
  const u = layer.usage;
  return {
    ...base,
    passed: cs.filter((r) => r.result.ok && !r.result.skipped).length,
    failed: cs.filter((r) => !r.result.ok && !r.result.inconclusive).length,
    skipped: cs.filter((r) => r.result.skipped).length,
    cached: cs.filter((r) => r.result.cached).length,
    inconclusive: cs.filter((r) => r.result.inconclusive).length,
    total: cs.length,
    ok: layer.ok,
    durationMs: layer.durationMs,
    halted: false,
    failedNames: cs.filter((r) => !r.result.ok && !r.result.skipped && !r.result.inconclusive).map((r) => r.name),
    tokens: u ? Math.max((u.inputTokens || 0) + (u.outputTokens || 0), u.totalTokens || 0) : 0,
  };
}

/** { plain, colored } so columns align on visible width despite ANSI codes. */
type Cell = { plain: string; colored: string };
const cell = (plain: string, colored?: string): Cell => ({ plain, colored: colored ?? plain });
const padCell = (x: Cell, w: number): string => x.colored + " ".repeat(Math.max(0, w - x.plain.length));

function statusCell(run: StageRun | null): Cell {
  if (!run) return cell("— not run —", c.dim("— not run —"));
  if (run.halted) return cell("⊘ halted", c.dim("⊘ halted"));
  const parts: Cell[] = [];
  if (run.passed) parts.push(cell(`✓${run.passed}`, c.green(`✓${run.passed}`)));
  if (run.failed) parts.push(cell(`✗${run.failed}`, c.red(`✗${run.failed}`)));
  if (run.inconclusive) parts.push(cell(`?${run.inconclusive}`, c.yellow(`?${run.inconclusive}`)));
  if (run.skipped) parts.push(cell(`○${run.skipped}`, c.yellow(`○${run.skipped}`)));
  if (run.cached) parts.push(cell(`⋯${run.cached}`, c.cyan(`⋯${run.cached}`)));
  if (!parts.length) return cell("—", c.dim("—"));
  return cell(parts.map((p) => p.plain).join(" "), parts.map((p) => p.colored).join(" "));
}

/** The dot before each stage: green ok · red fail · dim not-run/halted. */
function dot(run: StageRun | null): string {
  if (!run) return c.dim("○");
  if (run.halted) return c.dim("⊘");
  return run.ok ? c.green("●") : c.red("●");
}

export function renderPipelines(stages: PipelineStage[], summary: RunSummary | null, opts: PipelineOpts = {}): string[] {
  const out: string[] = [];
  out.push(
    c.bold("◆ heyllm") +
      c.dim(`  ${stages.length} pipeline${stages.length === 1 ? "" : "s"}  ·  gated pyramid: cheap → expensive, a failing gate halts the rest`)
  );

  const runs = stages.map((s) => rollup(summary, s.name, opts));

  // last-run banner
  if (summary) {
    const verdict = summary.ok ? c.green("PASS") : c.red("FAIL");
    const total = summary.layers.reduce((n, l) => n + l.cases.length, 0);
    const passed = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.ok && !r.result.skipped).length, 0);
    const cached = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.cached).length, 0);
    const skipped = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.skipped).length, 0);
    const tok = summary.usage ? Math.max((summary.usage.inputTokens || 0) + (summary.usage.outputTokens || 0), summary.usage.totalTokens || 0) : 0;
    const bits = [
      `${passed}/${total} cases`,
      cached ? c.cyan(`${cached} cached`) : "",
      skipped ? c.yellow(`${skipped} unchanged`) : "",
      tok ? c.dim(`~${compact(tok)} tok`) : "",
      ms(summary.durationMs),
      opts.ageMs !== undefined ? c.dim(relTime(opts.ageMs)) : "",
    ].filter(Boolean);
    out.push(`  ${c.dim("last run")}  ${verdict}  ${c.dim("·")}  ${bits.join(c.dim("  ·  "))}`);
    // when stages were refreshed at different times (a filtered --only run), say so
    const ages = runs.map((r) => r?.ageMs).filter((a): a is number => a !== undefined);
    if (ages.length && Math.max(...ages) - Math.min(...ages) > 5 * 60_000)
      out.push(c.dim("  (stages refreshed at different times — per-stage age shown below)"));
  } else {
    out.push(c.dim(`  no run recorded yet — run \`heyllm run\` to populate this dashboard`));
  }
  out.push("");

  // column widths (pad on PLAIN text, colour after)
  const nameW = Math.max(4, ...stages.map((s) => s.name.length));
  const kindW = Math.max(4, ...stages.map((s) => s.kind.length));
  const countW = Math.max(1, ...stages.map((s) => `${s.count}`.length));
  const statusCells = runs.map(statusCell);
  const statusW = Math.max(8, ...statusCells.map((x) => x.plain.length));

  stages.forEach((s, i) => {
    const run = runs[i];
    const name = padCell(cell(s.name, c.bold(s.name)), nameW);
    const kind = padCell(cell(s.kind, c.dim(s.kind)), kindW);
    const gate = s.gate ? c.yellow("gate") : c.dim("    ");
    const count = c.dim(`${s.count}`.padStart(countW) + (s.count === 1 ? " case " : " cases"));
    const status = padCell(statusCells[i], statusW);
    const tail: string[] = [];
    if (run && run.durationMs) tail.push(c.dim(ms(run.durationMs)));
    if (run && run.tokens) tail.push(c.dim(`~${compact(run.tokens)} tok`));
    if (run?.ageMs !== undefined && opts.ageMs !== undefined && Math.abs(run.ageMs - opts.ageMs) > 5 * 60_000)
      tail.push(c.dim(relTime(run.ageMs)));
    out.push(`  ${dot(run)}  ${name}  ${kind}  ${gate}  ${count}  ${status}  ${tail.join(c.dim(" · "))}`.trimEnd());
    // triage detail: which cases failed / flip flaky (always shown — this is the point)
    if (run?.failedNames.length) out.push(`  ${c.dim("│")}     ${c.red("↳ failed:")} ${c.dim(run.failedNames.join(", "))}`);
    if (run?.flaky.length) out.push(`  ${c.dim("│")}     ${c.yellow("↳ flaky:")} ${c.dim(run.flaky.join(", ") + " (flips across runs)")}`);
    if (opts.verbose && s.tags.length) out.push(`  ${c.dim("│")}     ${c.dim("tags: " + s.tags.join(", "))}`);
    if (opts.verbose && s.driver) out.push(`  ${c.dim("│")}     ${c.dim("driver: " + s.driver)}`);
    if (i < stages.length - 1) out.push(`  ${c.dim("│")}`);
  });

  out.push("");
  out.push(
    c.dim("  ") +
      [
        c.green("✓") + c.dim(" pass"),
        c.red("✗") + c.dim(" fail"),
        c.yellow("○") + c.dim(" skipped/unchanged"),
        c.cyan("⋯") + c.dim(" cached replay"),
        c.dim("⊘ halted"),
        c.yellow("gate") + c.dim(" halts on fail"),
      ].join(c.dim("   "))
  );
  return out;
}

/** Given the rolling run-history, the case names per stage that FLIPPED pass↔fail
 *  across recent runs — flakiness a single run can never show. */
export function flakyFromHistory(
  history: { stages?: Record<string, Record<string, string[]>> },
  stageNames: string[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of stageNames) {
    const stage = history.stages?.[name];
    if (!stage) continue;
    const flaky = Object.entries(stage)
      .filter(([, v]) => Array.isArray(v) && v.length >= 2 && v.includes("pass") && v.includes("fail"))
      .map(([caseName]) => caseName);
    if (flaky.length) out[name] = flaky;
  }
  return out;
}

/** Machine-readable dashboard — `heyllm pipelines --json` (CI badges, external dashboards). */
export function pipelinesJson(stages: PipelineStage[], summary: RunSummary | null, opts: PipelineOpts = {}) {
  return {
    ok: summary?.ok ?? null,
    ranAt: opts.ageMs !== undefined && summary ? new Date(Date.now() - opts.ageMs).toISOString() : null,
    pipelines: stages.map((s) => {
      const r = rollup(summary, s.name, opts);
      return {
        name: s.name,
        kind: s.kind,
        gate: s.gate,
        cases: s.count,
        tags: s.tags,
        driver: s.driver ?? null,
        lastRun: r
          ? {
              ok: r.ok,
              halted: r.halted,
              passed: r.passed,
              failed: r.failed,
              skipped: r.skipped,
              cached: r.cached,
              inconclusive: r.inconclusive,
              failedCases: r.failedNames,
              flakyCases: r.flaky,
              tokens: r.tokens,
              durationMs: r.durationMs,
              ageMs: r.ageMs ?? null,
            }
          : null,
      };
    }),
  };
}
