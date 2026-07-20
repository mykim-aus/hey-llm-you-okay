/**
 * JSON reporter — machine-readable full dump for dashboards/automation.
 */
import { writeFile } from "node:fs/promises";
import type { RunSummary } from "../types.js";

export async function writeJsonReport(summary: RunSummary, file: string): Promise<void> {
  const slim = {
    ...summary,
    layers: summary.layers.map((l) => ({
      ...l,
      cases: l.cases.map(({ def, baseDir, ...rest }) => ({
        ...rest,
        result: { ...rest.result, resolvedInputs: undefined, attemptsDetail: undefined },
      })),
    })),
  };
  await writeFile(file, JSON.stringify(slim, null, 2) + "\n");
}
