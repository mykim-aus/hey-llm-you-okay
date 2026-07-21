/**
 * Console reporter — the default human-facing output.
 */
import type { LayerRunResult, RunSummary, TriageReport } from "../types.js";
import { c, ms, truncate } from "../util.js";

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
    // A verdict the judges could not reproduce is neither a pass nor a fail.
    if (r.result.inconclusive) {
      const a = r.result.agreement;
      console.log(
        `  ${c.yellow("?")} ${c.bold(r.name)} ${c.yellow("INCONCLUSIVE")}` +
          (a ? c.dim(` (votes spread ${a.spread}${a.worstItem ? `, worst: ${a.worstItem}` : ""})`) : "")
      );
      console.log(`      ${c.yellow("↳")} ${r.result.inconclusive}`);
      if (verbose && r.result.votes)
        for (const [i, v] of r.result.votes.entries())
          console.log(c.dim(`      vote[${i}] ${v.weighted} ${JSON.stringify(v.scores)}`));
      continue;
    }
    const agree = r.result.agreement;
    const scoreTag =
      r.result.score !== undefined
        ? c.cyan(` ${r.result.score}/${r.result.scale?.max ?? 10}`) +
          (agree && (r.result.votes?.length ?? 0) > 1
            ? c.dim(agree.spread === 0 ? " ±0" : ` ±${agree.spread}`)
            : "")
        : "";
    if (r.result.ok) {
      if (verbose) console.log(`  ${MARK.pass} ${r.name}${scoreTag} ${c.dim(ms(r.durationMs))}`);
      else console.log(`  ${MARK.pass} ${r.name}${scoreTag}`);
    } else {
      console.log(`  ${MARK.fail} ${c.bold(r.name)}${scoreTag}`);
      for (const f of r.result.failures.slice(0, 6))
        console.log(`      ${c.red("↳")} ${f.path ? c.dim(f.path + ": ") : ""}${f.message}`);
      // compareReport is primary content (the size/section summary leads it), so
      // print it HEAD-first and undimmed — unlike outputTail scrollback.
      if (r.result.compareReport) console.log(indent(r.result.compareReport, 6));
      if (r.result.outputTail) console.log(c.dim(indent(r.result.outputTail.slice(-1200), 6)));
    }
    if (verbose && r.result.votes?.length) {
      for (const [i, v] of r.result.votes.entries()) {
        console.log(c.dim(`      vote[${i}] ${v.weighted} ${JSON.stringify(v.scores)} — ${v.reasoning}`));
        for (const [id, span] of Object.entries(v.spans || {}))
          console.log(c.dim(`         evidence[${id}] ${span}`));
      }
    }
    if (verbose && r.result.dispatchState !== undefined)
      console.log(c.dim(`      dispatch → state ${truncate(JSON.stringify(r.result.dispatchState), 160)}`));
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
    // A low-confidence attribution is flagged next to the verdict — the tool
    // must not present an n=3 guess with the same authority as a clean call.
    const confTag =
      t.confidence && t.confidence !== "high"
        ? (t.confidence === "low" ? c.yellow : c.dim)(` (confidence: ${t.confidence})`)
        : "";
    console.log(`  ${VERDICT_LABEL[t.verdict]} ${c.bold(`${t.layer}/${t.caseName}`)}${confTag}`);
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
  // Surfaced before the verdict line, and phrased as "nothing was verified"
  // rather than "a test failed" — the whole point of tracking this separately
  // is that no verdict exists for these cases.
  if (summary.infra?.length) {
    console.log(c.red(c.bold("◆ NOT VERIFIED — a provider could not be reached")));
    for (const p of summary.infra)
      console.log(
        `  ${c.red("!")} ${p.layer}/${p.case}${p.provider ? c.dim(` [${p.provider}]`) : ""}\n      ${p.message}`
      );
    console.log(
      c.dim("  these cases produced no verdict; exit code 2 (config/environment), not 1")
    );
    console.log("");
  }
  printSpend(summary, verbose);
  const total = summary.layers.reduce((s, l) => s + l.cases.length, 0);
  // Skipped cases are NOT passes. Counting them as such is how an ingested
  // 275-row backlog would print "275/275 PASS" having verified nothing — the
  // same lie, one level up from the case list.
  const skipped = summary.layers.reduce((s, l) => s + l.cases.filter((r) => r.result.skipped).length, 0);
  const passed = summary.layers.reduce(
    (s, l) => s + l.cases.filter((r) => r.result.ok && !r.result.skipped).length,
    0
  );
  const verdict = summary.ok ? c.green("PASS") : c.red("FAIL");
  const warn = summary.layers.filter((l) => !l.ok && !l.gate).length;
  console.log(
    `${c.bold("RESULT:")} ${verdict} — ${passed}/${total} cases${skipped ? c.yellow(` (${skipped} skipped, unverified)`) : ""}, ${summary.layers.length} layers${warn ? c.yellow(` (${warn} non-gated layer(s) failing)`) : ""} ${c.dim(ms(summary.durationMs))}${summary.profile ? c.dim(` [profile: ${summary.profile}]`) : ""}`
  );
}

const nf = (n: number) => n.toLocaleString("en-US");

/**
 * Token spend. Suppressed entirely on a static-only run (no `usage` key). The
 * caveat lines are the honesty, not a verbose extra: whenever a call went
 * unmetered or reported no split, the totals are a FLOOR and the `≥` prefix
 * plus the ⚠ lines say so — a number that looks exact when it is not is the
 * same failure class this tool exists to catch.
 */
export function printSpend(summary: RunSummary, verbose: boolean): void {
  const u = summary.usage;
  if (!u) return;
  if (u.inputTokens === 0 && u.outputTokens === 0 && u.totalTokens === 0) {
    console.log(
      c.dim(
        `TOKENS: not reported — no provider returned usage (command providers never do)`
      )
    );
    console.log("");
    return;
  }
  const floor = u.unmetered > 0 || u.unsplit > 0;
  const ge = floor ? "≥" : "";
  console.log(
    `${c.bold("TOKENS:")} ${ge}${nf(u.inputTokens)} in · ${ge}${nf(u.outputTokens)} out · ${nf(u.calls)} calls` +
      (u.reasoningTokens ? c.dim(` (${nf(u.reasoningTokens)} reasoning)`) : "")
  );
  if (u.unmetered > 0) {
    const kinds = [...new Set(u.buckets.filter((b) => b.unmetered > 0).map((b) => `${b.provider}/${b.kind}`))].join(", ");
    console.log(c.yellow(`  ⚠ ${u.unmetered} of ${u.calls} call(s) reported no usage (${kinds}) — the numbers above are a FLOOR`));
  }
  if (u.unsplit > 0)
    console.log(c.yellow(`  ⚠ ${u.unsplit} call(s) reported only a total, with no input/output split`));
  if (verbose && u.buckets.length) {
    console.log(c.dim("◆ per provider"));
    for (const b of u.buckets)
      console.log(
        c.dim(
          `  ${b.provider}${b.model ? ` ${b.model}` : ""}  ${nf(b.calls)} calls  ${nf(b.inputTokens)} in  ${nf(b.outputTokens)} out` +
            (b.unmetered ? `  (${b.unmetered} unmetered)` : "")
        )
      );
  }
  console.log("");
}
