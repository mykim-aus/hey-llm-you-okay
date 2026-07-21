/**
 * Changed-only run store — `.heyllm/prompts.json`.
 *
 * WHY THIS EXISTS: on a PR that touches one prompt, re-running every LLM case is
 * slow and costs tokens for cases whose input did not move. `--changed-only`
 * skips a case when the EXACT thing sent to the model is byte-identical to the
 * last time that case ran, and runs the rest.
 *
 * WHY A PAYLOAD FINGERPRINT, NOT A FILE DIFF (both measured on a real project):
 *   - A tool DESCRIPTION edit changed which tool the model picked, with the
 *     prompt builder untouched — a file-diff scoped to prompt files misses it;
 *     hashing the resolved tool declarations catches it.
 *   - A prompt assembled from a DATABASE changed with NO source file touched —
 *     a file diff sees nothing; resolving then hashing the real text catches it.
 *   So the unit is not "which files changed" but "did the bytes we send change".
 *
 * WHAT THE FINGERPRINT COVERS: system prompt, the user turns (prompt/messages/
 * conversation), tool declarations, sampling params, and the MODEL id. Change
 * any one and the case is testing a different thing, so it must re-run.
 *
 * WHAT IT CANNOT COVER: model drift. The vendor can change a model's behavior
 * with the payload byte-identical. `--changed-only` is for fast inner/PR loops;
 * a periodic FULL run stays necessary and `lastFullRunAt` records when the last
 * one happened so a caller can warn when it goes stale. `--always <layers>`
 * forces a canary layer to run every time regardless of fingerprint.
 *
 * RECORD-ON-PASS: the runner stores a case's fingerprint only when it actually
 * ran AND passed. A failing case is never recorded, so it keeps re-running under
 * --changed-only until it is green — a broken test is never skipped as
 * "unchanged". (This is the deliberate inverse of the ledger, which records
 * every run: there the goal is measuring stability; here it is never hiding red.)
 *
 * COMMIT POLICY: like the ledger, this file changes on every run and is NOT
 * committed — `heyllm init` gitignores `.heyllm/` except the reviewed baseline.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ResolvedLlmInputs } from "./types.js";

export const PROMPTS_RELPATH = ".heyllm/prompts.json";

export interface PromptRecord {
  /** fingerprint of the exact payload sent to the model */
  fp: string;
  /** ISO time this case last ran (passed in by the caller — the runner clock) */
  at: string;
  /** the last passing model OUTPUT for this exact payload. When --changed-only
   *  finds the input unchanged, the assertions are re-run against THIS instead
   *  of paying for a model call — so an unchanged case still reports a real
   *  verdict (and a changed `expect:` is re-checked for free), rather than a
   *  bare "skipped". Cached only for cases with no dispatch block (a dispatch
   *  fold cannot be faithfully replayed from text alone). */
  output?: CachedOutput;
}

export interface CachedTurn {
  text: string;
  fullText: string;
  toolCalls: { id?: string; name: string; args: Record<string, unknown> }[];
}

export interface CachedOutput {
  text: string;
  fullText: string;
  /** tool calls with args, so toolCalled/toolArgs replay exactly */
  toolCalls: { id?: string; name: string; args: Record<string, unknown> }[];
  /** conversation cases: each turn's output, so a multi-turn dispatch fold can be
   *  re-driven (threaded per-turn UI state) on replay — the whole conversation's
   *  response→UI matrix re-verified at zero model cost under --changed-only. */
  turns?: CachedTurn[];
}

export interface PromptStore {
  version: 1;
  /** ISO time of the last run with NO layer filter (a full sweep). Lets a
   *  caller warn that changed-only skips are getting stale vs. model drift. */
  lastFullRunAt?: string;
  cases: Record<string, PromptRecord>;
}

const shortHash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * Blank out declared-volatile regions before hashing. WHY: a production prompt
 * often carries per-run content that is NOT a code change — sampled review
 * words, a "recent session" recap, a timestamp. Left in, the fingerprint moves
 * every run and --changed-only can never skip (safe, but useless). `ignore`
 * patterns strip those regions FROM THE FINGERPRINT ONLY; the model still
 * receives the full, unmodified prompt. The tradeoff is explicit: a real code
 * change confined to an ignored region will not be detected — so ignore the
 * data, never the instructions around it.
 */
/** Accept a single pattern or a list; a lone string is a common convenience. */
export function normalizeIgnore(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const out = list.filter((x) => typeof x === "string") as string[];
  return out.length ? out : undefined;
}

function applyIgnore(text: string, ignore?: string[]): string {
  if (!ignore?.length) return text;
  let out = text;
  for (const p of ignore) {
    let re: RegExp;
    try {
      // `gm`, not `g`: a prompt is multi-line and the natural way to ignore a
      // volatile line is `^TS: .*$`. Without the `m` flag, `^`/`$` anchor to the
      // whole string, so a line in the MIDDLE never matches and the ignore
      // silently does nothing — the fingerprint keeps moving and the user cannot
      // tell why. Line-oriented patterns are the whole use case, so `m` is on.
      re = new RegExp(p, "gm");
    } catch (e: any) {
      throw new Error(`invalid fingerprintIgnore pattern ${JSON.stringify(p)}: ${e.message}`);
    }
    out = out.replace(re, "«ignored»");
  }
  return out;
}

/**
 * Fingerprint EXACTLY what determines this case's model behavior. Ordered array
 * (not an object) so serialization is deterministic across runs; a versioned
 * tag up front means a future change to WHAT we hash invalidates old records
 * rather than silently comparing across schemas. `ignore` blanks declared
 * volatile regions in the system + user turns (see applyIgnore).
 */
export function fingerprintLlm(inputs: ResolvedLlmInputs, model?: string, ignore?: string[]): string {
  const strip = <T>(s: T): T => (typeof s === "string" ? (applyIgnore(s, ignore) as unknown as T) : s);
  const turns =
    inputs.mode === "conversation"
      ? (inputs.conversation || []).map((t: any) =>
          typeof t?.content === "string" ? { ...t, content: strip(t.content) } : t
        )
      : inputs.mode === "messages"
        ? (inputs.messages || []).map((m) => ({ ...m, content: strip(m.content) }))
        : inputs.prompt !== undefined
          ? strip(inputs.prompt)
          : null;
  return shortHash(
    JSON.stringify([
      "llm-v2",
      strip(inputs.system) ?? null,
      turns ?? null,
      inputs.tools ?? null,
      inputs.params ?? {},
      model ?? null,
      inputs.providerName ?? null,
      ignore ?? null,
    ])
  );
}

/** Extend a base LLM fingerprint with the judge rubric — changing the rubric
 *  means judging differently, so the case must re-run even if the subject
 *  prompt is unchanged. `extra` is any JSON-serializable rubric spec. */
export function fingerprintWith(base: string, extra: unknown): string {
  return shortHash(JSON.stringify(["with-v1", base, extra ?? null]));
}

export async function loadPromptStore(baseDir: string): Promise<PromptStore> {
  try {
    const parsed = JSON.parse(await readFile(path.join(baseDir, PROMPTS_RELPATH), "utf8"));
    return { version: 1, lastFullRunAt: parsed.lastFullRunAt, cases: parsed.cases || {} };
  } catch {
    return { version: 1, cases: {} };
  }
}

export async function savePromptStore(baseDir: string, store: PromptStore): Promise<string> {
  const file = path.join(baseDir, PROMPTS_RELPATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2) + "\n");
  return file;
}

/**
 * The skip decision, in one place so llm and judge cannot drift apart.
 * Returns the human-readable skip reason when the case should be skipped, or
 * null when it must run. `alwaysRun` (a canary layer) never skips.
 */
export function unchangedSkipReason(
  store: PromptStore | undefined,
  key: string,
  fp: string,
  alwaysRun: boolean
): string | null {
  if (!store || alwaysRun) return null;
  const prev = store.cases[key];
  if (prev && prev.fp === fp) return `unchanged — payload identical since ${prev.at}`;
  return null;
}

/**
 * Why a case RAN under --changed-only (it was not skipped). Only interesting
 * when a baseline existed and the payload DIFFERS from it: that case will re-run
 * every time, silently defeating the cost saving. If the user did not edit the
 * prompt, that is a non-deterministic payload (random review words, a
 * timestamp, a session recap) — which also blocks triage's byte-identical
 * fast-path — and the fix is `fingerprintIgnore`. Returns null for the ordinary
 * "no baseline yet" first run (nothing to warn about).
 */
/**
 * Whether a cache entry is too OLD to trust, given a max age in days. The input
 * has not changed, but the provider might have — so past this age --changed-only
 * re-verifies against the live model instead of replaying. Returns false when no
 * age limit is set (cache never expires on age) or the timestamp is unparseable
 * (fail toward re-running, never toward trusting a bad timestamp).
 */
export function isCacheStale(at: string | undefined, maxAgeDays: number | undefined, nowMs: number): boolean {
  if (!maxAgeDays || maxAgeDays <= 0) return false;
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeDays * 86_400_000;
}

export function changedRunReason(store: PromptStore | undefined, key: string, fp: string): string | null {
  const prev = store?.cases[key];
  if (prev && prev.fp !== fp)
    return `payload changed since ${prev.at} — if you did not edit it, the inputs are non-deterministic (random/timestamped content); add fingerprintIgnore so --changed-only and triage can compare it`;
  return null;
}
