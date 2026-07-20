/**
 * Baseline store — `.heyllm/baseline.json`, committed to git.
 *
 * Two things live here, keyed by "<layer>/<case>":
 *   scores    — last accepted judge medians (score-regression detection)
 *   snapshots — the EXACT resolved inputs (system prompt, tools, messages)
 *               that last passed, plus provider/model identity.
 *
 * Snapshots are what the triage A/B probe replays as the "old" arm: if the
 * old inputs also fail under today's model, your change didn't break it —
 * the model drifted.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BaselineFile, ResolvedLlmInputs, Scale, SnapshotEntry } from "./types.js";

export const BASELINE_RELPATH = ".heyllm/baseline.json";

export const caseKey = (layerName: string, caseName: string) => `${layerName}/${caseName}`;

export async function loadBaseline(baseDir: string): Promise<BaselineFile> {
  try {
    const raw = await readFile(path.join(baseDir, BASELINE_RELPATH), "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, scores: parsed.scores || {}, snapshots: parsed.snapshots || {} };
  } catch {
    return { version: 1, scores: {}, snapshots: {} };
  }
}

export async function saveBaseline(baseDir: string, baseline: BaselineFile): Promise<string> {
  const file = path.join(baseDir, BASELINE_RELPATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(baseline, null, 2) + "\n");
  return file;
}

export function recordScore(
  baseline: BaselineFile,
  key: string,
  score: number,
  scale: Scale
): void {
  baseline.scores[key] = { score, scale, at: new Date().toISOString() };
}

export function recordSnapshot(
  baseline: BaselineFile,
  key: string,
  entry: { provider: string; model?: string; inputs: ResolvedLlmInputs; score?: number }
): void {
  const snap: SnapshotEntry = { at: new Date().toISOString(), ...entry };
  baseline.snapshots[key] = snap;
}

/** Score-regression check: fail when score < baseline - maxDrop. */
export function checkRegression(
  baseline: BaselineFile,
  key: string,
  score: number,
  maxDrop: number
): { regressed: boolean; baselineScore?: number } {
  const prev = baseline.scores[key];
  if (!prev) return { regressed: false };
  return { regressed: score < prev.score - maxDrop, baselineScore: prev.score };
}
