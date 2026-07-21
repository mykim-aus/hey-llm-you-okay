/**
 * Pipeline dashboard — `heyllm pipelines`. Answers three questions at a glance:
 *   what pipelines exist · how they flow (the gated pyramid) · how the last run went.
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

function rollup(summary: RunSummary | null, name: string): StageRun | null {
  if (!summary) return null;
  if (summary.halted?.includes(name))
    return { passed: 0, failed: 0, skipped: 0, cached: 0, inconclusive: 0, total: 0, ok: false, durationMs: 0, halted: true };
  const layer = summary.layers.find((l) => l.name === name);
  if (!layer) return null;
  const cs = layer.cases;
  return {
    passed: cs.filter((r) => r.result.ok && !r.result.skipped).length,
    failed: cs.filter((r) => !r.result.ok && !r.result.inconclusive).length,
    skipped: cs.filter((r) => r.result.skipped).length,
    cached: cs.filter((r) => r.result.cached).length,
    inconclusive: cs.filter((r) => r.result.inconclusive).length,
    total: cs.length,
    ok: layer.ok,
    durationMs: layer.durationMs,
    halted: false,
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

export function renderPipelines(
  stages: PipelineStage[],
  summary: RunSummary | null,
  opts: { verbose?: boolean; ageMs?: number } = {}
): string[] {
  const out: string[] = [];
  out.push(
    c.bold("◆ heyllm") +
      c.dim(`  ${stages.length} pipeline${stages.length === 1 ? "" : "s"}  ·  gated pyramid: cheap → expensive, a failing gate halts the rest`)
  );

  // last-run banner
  if (summary) {
    const verdict = summary.ok ? c.green("PASS") : c.red("FAIL");
    const total = summary.layers.reduce((n, l) => n + l.cases.length, 0);
    const passed = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.ok && !r.result.skipped).length, 0);
    const cached = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.cached).length, 0);
    const skipped = summary.layers.reduce((n, l) => n + l.cases.filter((r) => r.result.skipped).length, 0);
    const bits = [
      `${passed}/${total} cases`,
      cached ? c.cyan(`${cached} cached`) : "",
      skipped ? c.yellow(`${skipped} unchanged`) : "",
      ms(summary.durationMs),
      opts.ageMs !== undefined ? c.dim(relTime(opts.ageMs)) : "",
    ].filter(Boolean);
    out.push(`  ${c.dim("last run")}  ${verdict}  ${c.dim("·")}  ${bits.join(c.dim("  ·  "))}`);
  } else {
    out.push(c.dim(`  no run recorded yet — run \`heyllm run\` to populate this dashboard`));
  }
  out.push("");

  // column widths (pad on PLAIN text, colour after)
  const nameW = Math.max(4, ...stages.map((s) => s.name.length));
  const kindW = Math.max(4, ...stages.map((s) => s.kind.length));
  const countCells = stages.map((s) => `${s.count}`);
  const countW = Math.max(1, ...countCells.map((x) => x.length));
  const runs = stages.map((s) => rollup(summary, s.name));
  const statusCells = runs.map(statusCell);
  const statusW = Math.max(8, ...statusCells.map((x) => x.plain.length));

  stages.forEach((s, i) => {
    const run = runs[i];
    const name = padCell(cell(s.name, c.bold(s.name)), nameW);
    const kind = padCell(cell(s.kind, c.dim(s.kind)), kindW);
    const gate = s.gate ? c.yellow("gate") : c.dim("    ");
    const count = c.dim(`${s.count}`.padStart(countW) + (s.count === 1 ? " case " : " cases"));
    const status = padCell(statusCells[i], statusW);
    const dur = run && run.durationMs ? c.dim(ms(run.durationMs)) : "";
    out.push(`  ${dot(run)}  ${name}  ${kind}  ${gate}  ${count}  ${status}  ${dur}`.trimEnd());
    if (opts.verbose && s.tags.length) out.push(`  ${c.dim("│")}     ${c.dim("tags: " + s.tags.join(", "))}`);
    if (i < stages.length - 1) out.push(`  ${c.dim("│")}`);
  });

  out.push("");
  out.push(
    c.dim("  ") +
      [c.green("✓") + c.dim(" pass"), c.red("✗") + c.dim(" fail"), c.yellow("○") + c.dim(" skipped/unchanged"), c.cyan("⋯") + c.dim(" cached replay"), c.dim("⊘ halted"), c.yellow("gate") + c.dim(" halts on fail")].join(c.dim("   "))
  );
  return out;
}
