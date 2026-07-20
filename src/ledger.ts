/**
 * Run-axis reliability ledger — `.heyllm/ledger.json`.
 *
 * WHY THIS EXISTS (a correction to how this tool first measured trust):
 *   A judge was observed scoring the same rubric item 9,8 → 2,3 → 10,9 across
 *   three runs. Vote agreement WITHIN each run was perfect (spread 1), so a
 *   vote-spread gate called all three "stable" — and the middle run's tight
 *   internal agreement stamped confidence on a verdict that was 6 points off.
 *   The instability lived on the TIME axis, not the vote axis. Measuring more
 *   votes cannot see it; only remembering previous runs can.
 *
 * COMMIT POLICY: `.heyllm/baseline.json` is a reviewed artifact and belongs in
 * git. This ledger is NOT — it changes on every run and would conflict on every
 * branch. `heyllm init` scaffolds `.heyllm/.gitignore` accordingly.
 *
 * Two properties make this cheap:
 *   - zero extra model calls: it records what a run already produced
 *   - written on every run, pass OR fail — a ledger that only remembers
 *     successes ratchets to the top of the distribution and lies
 *
 * ATTRIBUTION: each observation stores a hash of the subject output that was
 * judged. If scores diverge while the output hash is identical, the judge is
 * the unstable part. If the hashes differ, the subject model also moved and
 * the spread is confounded — the tool says which, instead of guessing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const LEDGER_RELPATH = ".heyllm/ledger.json";
const KEEP_RUNS = 10;

export interface LedgerObservation {
  at: string;
  /** every vote's score for this item in that run */
  scores: number[];
  /** short hash of the judged subject output — the attribution key */
  out: string;
  /** cited evidence, when the rubric asked for it */
  span?: string;
}

export interface LedgerItem {
  /** rubric-item fingerprint: changing the question resets the history */
  fp: string;
  runs: LedgerObservation[];
}

export interface LedgerFile {
  version: 1;
  items: Record<string, LedgerItem>;
}

export const shortHash = (s: string): string =>
  createHash("sha1").update(String(s)).digest("hex").slice(0, 6);

/** Item identity: layer/case#rubricId. Per ITEM, not per case — editing one
 *  rubric item must not throw away the history of its siblings. */
export const itemKey = (layer: string, caseName: string, rubricId: string) =>
  `${layer}/${caseName}#${rubricId}`;

/** Fingerprint what would change the meaning of a score. */
export const itemFingerprint = (parts: {
  question: string;
  rules?: string[];
  ask?: string;
  judgeModel?: string;
}) =>
  shortHash(
    JSON.stringify([parts.question, parts.rules ?? [], parts.ask ?? "scale", parts.judgeModel ?? ""])
  );

export async function loadLedger(baseDir: string): Promise<LedgerFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(baseDir, LEDGER_RELPATH), "utf8"));
    return { version: 1, items: parsed.items || {} };
  } catch {
    return { version: 1, items: {} };
  }
}

export async function saveLedger(baseDir: string, ledger: LedgerFile): Promise<string> {
  const file = path.join(baseDir, LEDGER_RELPATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ledger, null, 2) + "\n");
  return file;
}

/** Append one observation, dropping history whose fingerprint no longer matches. */
export function recordObservation(
  ledger: LedgerFile,
  key: string,
  fp: string,
  obs: LedgerObservation
): void {
  const existing = ledger.items[key];
  const item = existing && existing.fp === fp ? existing : { fp, runs: [] };
  item.runs.push(obs);
  if (item.runs.length > KEEP_RUNS) item.runs = item.runs.slice(-KEEP_RUNS);
  ledger.items[key] = item;
}

/** Why the scores moved. Only computable when there is history to compare. */
export type RunAxisAttribution = "judge-only" | "confounded";

export interface RunAxisReport {
  /** spread across ALL votes of ALL remembered runs */
  spread: number;
  runs: number;
  attribution: RunAxisAttribution;
  min: number;
  max: number;
}

/**
 * Reliability across runs. `minRuns` guards against calling a verdict unstable
 * on a single sample.
 */
export function runAxisSpread(item: LedgerItem | undefined, minRuns = 3): RunAxisReport | null {
  if (!item || item.runs.length < minRuns) return null;
  const all = item.runs.flatMap((r) => r.scores);
  if (!all.length) return null;
  const outs = new Set(item.runs.map((r) => r.out));
  return {
    spread: Math.round((Math.max(...all) - Math.min(...all)) * 100) / 100,
    runs: item.runs.length,
    min: Math.min(...all),
    max: Math.max(...all),
    // identical outputs scored differently ⇒ the judge moved, nothing else
    attribution: outs.size === 1 ? "judge-only" : "confounded",
  };
}

/** Items whose judges found the SAME evidence yet disagreed on the score —
 *  the signature of a missing decision rule, not of sampling noise. */
export function sameEvidenceDifferentScore(ledger: LedgerFile): string[] {
  const out: string[] = [];
  for (const [key, item] of Object.entries(ledger.items)) {
    const spans = new Set(item.runs.map((r) => r.span).filter(Boolean));
    if (spans.size !== 1) continue;
    const outs = new Set(item.runs.map((r) => r.out));
    if (outs.size !== 1) continue;
    const all = item.runs.flatMap((r) => r.scores);
    if (all.length > 1 && Math.max(...all) !== Math.min(...all)) out.push(key);
  }
  return out;
}
