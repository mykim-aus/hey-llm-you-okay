/**
 * JUnit XML reporter — for CI systems (GitHub Actions, GitLab, Jenkins).
 * One <testsuite> per layer; triage verdicts are appended to failure text.
 */
import { writeFile } from "node:fs/promises";
import type { RunSummary } from "../types.js";
import { xmlEscape } from "../util.js";

export async function writeJunitReport(summary: RunSummary, file: string): Promise<void> {
  const triageFor = (layer: string, caseName: string) =>
    summary.triage?.find((t) => t.layer === layer && t.caseName === caseName);

  const suites = summary.layers
    .map((l) => {
      const failures = l.cases.filter((r) => !r.result.ok).length;
      const skipped = l.cases.filter((r) => r.result.skipped).length;
      const cases = l.cases
        .map((r) => {
          const name = xmlEscape(r.name);
          const time = (r.durationMs / 1000).toFixed(3);
          if (r.result.skipped)
            return `    <testcase name="${name}" time="${time}"><skipped message="${xmlEscape(r.result.skipped)}"/></testcase>`;
          if (r.result.ok) return `    <testcase name="${name}" time="${time}"/>`;
          const t = triageFor(l.name, r.name);
          const msg = r.result.failures.map((f) => `${f.path ? f.path + ": " : ""}${f.message}`).join("\n");
          // The compare report is element BODY (legal, multi-line) — an attribute
          // could only hold the one-line summary, leaving JUnit-only CI with no
          // report at all.
          const compareBody = r.result.compareReport ? `\n\n${r.result.compareReport}` : "";
          const triageNote = t ? `\n[TRIAGE] ${t.verdict}: ${t.reason}` : "";
          return `    <testcase name="${name}" time="${time}"><failure message="${xmlEscape(
            r.result.failures[0]?.message || "failed"
          )}">${xmlEscape(msg + compareBody + triageNote)}</failure></testcase>`;
        })
        .join("\n");
      return `  <testsuite name="${xmlEscape(l.name)}" tests="${l.cases.length}" failures="${failures}" skipped="${skipped}" time="${(l.durationMs / 1000).toFixed(3)}">\n${cases}\n  </testsuite>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites time="${(summary.durationMs / 1000).toFixed(3)}">\n${suites}\n</testsuites>\n`;
  await writeFile(file, xml);
}
