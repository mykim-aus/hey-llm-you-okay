/**
 * Console reporter — the default human-facing output.
 */
import type { LayerRunResult, RunSummary, TriageReport } from "../types.js";
import { c, ms } from "../util.js";

const MARK = { pass: c.green("✓"), fail: c.red("✗"), skip: c.yellow("○") };

const VERDICT_LABEL: Record<TriageReport["verdict"], string> = {
  flaky: c.yellow("FLAKY"),
  "your-change": c.red("YOUR-CHANGE"),
  "model-drift": c.magenta("MODEL-DRIFT"),
  inconclusive: c.dim("INCONCLUSIVE"),
  "no-snapshot": c.dim("NO-SNAPSHOT"),
  "config-changed": c.cyan("CONFIG-CHANGED"),
};

export function printLayer(layer: LayerRunResult, verbose: boolean): void {
  const gateTag = layer.gate ? c.dim(" [gate]") : "";
  if (layer.skipped) {
    console.log(`${c.bold("▸ " + layer.name)}${gateTag} ${c.yellow("skipped")} — ${layer.skipped}`);
    return;
  }
  const passed = layer.cases.filter((r) => r.result.ok).length;
  const color = layer.ok ? c.green : c.red;
  console.log(
    `${c.bold("▸ " + layer.name)}${gateTag} ${color(`${passed}/${layer.cases.length}`)} ${c.dim(ms(layer.durationMs))}`
  );
  for (const r of layer.cases) {
    if (r.result.skipped) {
      console.log(`  ${MARK.skip} ${r.name} ${c.dim(`(${r.result.skipped})`)}`);
      continue;
    }
    const scoreTag =
      r.result.score !== undefined
        ? c.cyan(` ${r.result.score}/${r.result.scale?.max ?? 10}`)
        : "";
    if (r.result.ok) {
      if (verbose) console.log(`  ${MARK.pass} ${r.name}${scoreTag} ${c.dim(ms(r.durationMs))}`);
      else console.log(`  ${MARK.pass} ${r.name}${scoreTag}`);
    } else {
      console.log(`  ${MARK.fail} ${c.bold(r.name)}${scoreTag}`);
      for (const f of r.result.failures.slice(0, 6))
        console.log(`      ${c.red("↳")} ${f.path ? c.dim(f.path + ": ") : ""}${f.message}`);
      if (r.result.outputTail) console.log(c.dim(indent(r.result.outputTail.slice(-1200), 6)));
    }
    if (verbose && r.result.votes?.length) {
      for (const [i, v] of r.result.votes.entries())
        console.log(c.dim(`      vote[${i}] ${v.weighted} ${JSON.stringify(v.scores)} — ${v.reasoning}`));
    }
  }
}

const indent = (s: string, n: number) =>
  s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");

export function printTriage(reports: TriageReport[]): void {
  console.log("");
  console.log(c.bold("◆ TRIAGE — AI failure adjudication (A/B probe)"));
  for (const t of reports) {
    console.log(`  ${VERDICT_LABEL[t.verdict]} ${c.bold(`${t.layer}/${t.caseName}`)}`);
    console.log(`      ${t.reason}`);
    for (const arm of t.arms || [])
      console.log(
        c.dim(`      arm ${arm.label}: ${arm.passed}/${arm.attempts} passed`) +
          (arm.failures.length && arm.passed < arm.attempts
            ? c.dim(` — e.g. ${arm.failures[0].message.slice(0, 120)}`)
            : "")
      );
  }
}

export function printSummary(summary: RunSummary, verbose = false): void {
  console.log("");
  for (const layer of summary.layers) printLayer(layer, verbose);
  if (summary.halted.length)
    console.log(
      `${c.yellow("▸ halted")} ${summary.halted.join(", ")} ${c.dim("(a gated layer failed — pyramid stopped; --keep-going to override)")}`
    );
  if (summary.triage?.length) printTriage(summary.triage);
  console.log("");
  const total = summary.layers.reduce((s, l) => s + l.cases.length, 0);
  const passed = summary.layers.reduce((s, l) => s + l.cases.filter((r) => r.result.ok).length, 0);
  const verdict = summary.ok ? c.green("PASS") : c.red("FAIL");
  const warn = summary.layers.filter((l) => !l.ok && !l.gate).length;
  console.log(
    `${c.bold("RESULT:")} ${verdict} — ${passed}/${total} cases, ${summary.layers.length} layers${warn ? c.yellow(` (${warn} non-gated layer(s) failing)`) : ""} ${c.dim(ms(summary.durationMs))}${summary.profile ? c.dim(` [profile: ${summary.profile}]`) : ""}`
  );
}
