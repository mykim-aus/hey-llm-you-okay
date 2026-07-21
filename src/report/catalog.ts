/**
 * `heyllm list` — the pipeline CATALOG. A static, no-model, no-run view of what
 * every pipeline verifies: each case's name + one-line `description:` + tags,
 * grouped by pipeline. The "what does this suite even cover?" map that a
 * counts-only dashboard cannot give.
 *
 * Pure rendering: takes the config's pipelines (already loaded, filtered) and
 * returns lines. No I/O, no last-run — a catalog is about intent, not results.
 */
import { c } from "../util.js";

export interface CatalogCase {
  name: string;
  description?: string;
  tags: string[];
  /** true or a reason string — a case deliberately not run (ingested stub, etc.) */
  skip?: boolean | string;
}
export interface CatalogPipeline {
  name: string;
  kind: string;
  gate: boolean;
  /** provider(s) that back this pipeline, if any (llm→provider, judge→subject→judge) */
  driver?: string;
  cases: CatalogCase[];
}

const plainLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Render the catalog as aligned, scannable lines. */
export function renderCatalog(pipelines: CatalogPipeline[], opts: { verbose?: boolean } = {}): string[] {
  const out: string[] = [];
  const totalCases = pipelines.reduce((n, p) => n + p.cases.length, 0);
  const undescribed = pipelines.reduce((n, p) => n + p.cases.filter((cs) => !cs.description).length, 0);

  out.push(
    c.bold("◆ heyllm") +
      c.dim(`  ${pipelines.length} ${pipelines.length === 1 ? "pipeline" : "pipelines"} · ${totalCases} ${totalCases === 1 ? "case" : "cases"}`) +
      c.dim("      ") +
      c.dim("catalog · no runs, no model calls")
  );
  out.push("");

  for (const p of pipelines) {
    const driver = p.driver ? c.dim(` · ${p.driver}`) : "";
    const gate = p.gate ? c.dim(" · gate") : "";
    const n = p.cases.length;
    out.push(
      `${c.cyan("●")}  ${c.bold(p.name)}  ${c.dim(p.kind)}${driver}${gate}${c.dim(`  ${n} ${n === 1 ? "case" : "cases"}`)}`
    );
    if (!n) out.push(`     ${c.dim("(no cases)")}`);
    for (const cs of p.cases) {
      const skip = cs.skip ? c.yellow("  ⊘ skip") : "";
      out.push(`     ${c.bold(cs.name)}${skip}`);
      // description on its own indented line — the human summary, the whole point
      out.push(
        cs.description
          ? `       ${cs.description}`
          : `       ${c.dim("(no description — add `description:` so this case explains itself)")}`
      );
      if (cs.tags.length) out.push(`       ${c.dim(cs.tags.map((t) => `#${t}`).join(" "))}`);
    }
    out.push("");
  }

  // A catalog that hides how much of itself is unlabeled would be lying by
  // omission — surface the gap the same way the run surfaces unverified greens.
  if (undescribed) {
    out.push(
      c.dim(
        `${undescribed}/${totalCases} case${totalCases === 1 ? "" : "s"} have no description — ` +
          "add `description:` in the YAML so the catalog reads at a glance."
      )
    );
  } else if (totalCases) {
    out.push(c.dim(`every case is described.`));
  }
  return out.map((l) => l.replace(/\s+$/, ""));
  void plainLen; // reserved for a future aligned-columns mode
}

/** Machine-readable catalog for `heyllm list --json`. */
export function catalogJson(pipelines: CatalogPipeline[]): unknown {
  const totalCases = pipelines.reduce((n, p) => n + p.cases.length, 0);
  return {
    pipelines: pipelines.map((p) => ({
      name: p.name,
      kind: p.kind,
      gate: p.gate,
      driver: p.driver ?? null,
      cases: p.cases.map((cs) => ({
        name: cs.name,
        description: cs.description ?? null,
        tags: cs.tags,
        ...(cs.skip ? { skip: cs.skip } : {}),
      })),
    })),
    totals: {
      pipelines: pipelines.length,
      cases: totalCases,
      undescribed: pipelines.reduce((n, p) => n + p.cases.filter((cs) => !cs.description).length, 0),
    },
  };
}
