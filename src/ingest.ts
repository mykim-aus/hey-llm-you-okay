/**
 * Bulk corpus ingestion — `heyllm ingest export.jsonl --map input=<path>`.
 *
 * heyllm's README headlines a "Self-Growing Corpus Ledger", but `capture` only
 * took ONE input string at a time, so a production feedback store with 275
 * negative rows had no way in. This is the way in.
 *
 * The load-bearing constraint: an ingested case must NOT become a vacuous pass.
 * src/layers/llm.ts iterates `expect` keys — a case with no `expect` collects
 * zero failures and returns ok. Ingesting 275 assertion-less rows would add 275
 * green ticks that verify nothing, inflating apparent coverage by an order of
 * magnitude — the exact lie this tool exists to catch. So every ingested case
 * is written `skip:`ped with a TODO, which the runner reports as UNVERIFIED (a
 * ○, not a ✓), and the validator refuses to let anyone un-skip a stub whose
 * TODOs are still present. A backlog stays green and honest; finishing a row is
 * gated on actually finishing it.
 *
 * Format is JSONL, not CSV: these rows carry multi-line "STEPS TO REPRODUCE"
 * blocks — embedded newlines and commas, RFC-4180's hard case — and every
 * zero-dep CSV bug mode is silent truncation, i.e. a case that tests half a
 * sentence and passes. JSON.parse per line is a built-in and fails loudly with
 * a line number. Any store exports JSON: `jq -c '.[]' export.json > rows.jsonl`.
 *
 * O(n²) trigram dedup (275² ≈ 38k small set intersections, low ms) — no MinHash,
 * no dependency. Fuzzy dedup is OPT-IN because "reworded same complaint" and
 * "different complaint, same feature" are not cleanly separable at any threshold
 * (measured), and a false merge silently deletes a distinct test — losing
 * coverage while believing you gained it. Bias hard toward splitting.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { deepGet } from "./util.js";
import { shortHash } from "./ledger.js";
import type { CaseDef, HeyLLMConfig } from "./types.js";

const MAP_TARGETS = ["input", "expected", "steps", "id", "url", "note", "tags", "name"] as const;
type MapTarget = (typeof MAP_TARGETS)[number];

export interface IngestOptions {
  map: Record<string, string>; // caseField -> dotted json path
  sourceName?: string;
  layer?: string;
  out?: string;
  dedup?: "exact" | "near";
  dedupThreshold?: number;
  dryRun?: boolean;
  skipInvalid?: boolean;
  limit?: number;
}

export interface IngestResult {
  file: string;
  layer: string;
  newCases: number;
  duplicateInBatch: number;
  alreadyInLedger: number;
  invalidDropped: number;
  clusters: { name: string; digest: string; duplicates: number }[];
  dryRun: boolean;
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Parse JSONL (one object per line), or a whole-buffer JSON array when the
 *  first non-whitespace byte is `[`. Errors name the line. */
export function parseRows(text: string): Record<string, unknown>[] {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (e: any) {
      throw new Error(`input looks like a JSON array but failed to parse: ${e.message}`);
    }
    if (!Array.isArray(arr)) throw new Error("input parsed to a non-array");
    return arr as Record<string, unknown>[];
  }
  const rows: Record<string, unknown>[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e: any) {
      throw new Error(`line ${i + 1}: ${e.message} (pipe an API export through \`jq -c '.[]'\` to get JSONL)`);
    }
  }
  return rows;
}

// ── normalization + dedup ────────────────────────────────────────────────────

// NFKC, lowercase, non-alphanumeric→space, collapse, trim. DIGITS ARE KEPT:
// "order 993" and "order 118" are different complaints; stripping numbers merges
// them. Uses \p{L}\p{N} so it works on any script (this project's own corpus is
// Korean — a word/stopword rule would make a "domain-neutral" tool English-only).
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const g = new Set<string>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Row {
  input: string;
  expected?: string;
  steps?: string;
  id?: string;
  url?: string;
  note?: string;
  tags?: string[];
  digest: string;
  norm: string;
  grams: Set<string>;
  raw: Record<string, unknown>;
}

// ── the rubric skeleton — TODO-marked, structurally incapable of passing ──────

function buildCase(row: Row, sourceName: string, cluster: { duplicates: number; ids: string[]; mergedRaw: string[] }): CaseDef {
  const id = row.id ?? row.digest;
  const name = `ingested-${sourceName}-${id}`.replace(/[^\w.-]+/g, "-");
  // ask: binary, not the 1-10 default — an "expected behavior" harvested from a
  // complaint is a fulfilment question ("did it do X?"), which is natively
  // binary. Defaulting to a scale manufactures a grey zone the source data does
  // not have, and 275 of them would flood the reliability ledger.
  const expectedText = row.expected?.trim();
  const question = expectedText
    ? `TODO REVIEW — Does the response do this? << ${expectedText.replace(/\s+/g, " ")} >>`
    : `TODO REVIEW — write the yes/no question this complaint implies. Complaint: << ${row.input.replace(/\s+/g, " ").slice(0, 200)} >>`;
  const source: Record<string, unknown> = {
    system: sourceName,
    ...(row.id ? { id: row.id } : {}),
    ...(row.url ? { url: row.url } : {}),
    digest: row.digest,
    raw: row.input,
    ...(expectedText ? { expected: expectedText } : {}),
    ...(row.steps ? { steps: row.steps } : {}),
    ...(cluster.duplicates ? { duplicates: cluster.duplicates, duplicateIds: cluster.ids.slice(0, 20).sort() } : {}),
    ...(cluster.mergedRaw.length ? { mergedRaw: cluster.mergedRaw } : {}),
  };
  return {
    name,
    skip: `unreviewed — ingested from ${sourceName} ${id}; fill in the rubric below, then remove this line`,
    tags: ["captured", "ingested", "unreviewed", ...(row.tags || [])],
    input: { prompt: (row.steps?.trim() || row.input).trim() },
    rubric: [
      {
        id: "expected-behavior",
        ask: "binary",
        citeSpan: true,
        question,
        rules: ["TODO: one sentence — what counts as satisfying this.", "TODO: one sentence — the closest thing that does NOT count."],
      },
    ],
    source,
  } as CaseDef;
}

// ── the ledger, comment-preserving + atomic ──────────────────────────────────

async function readLedgerDoc(file: string): Promise<any> {
  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ledger ${file}: ${e.message}`);
  }
  if (raw === null) return YAML.parseDocument("cases: []\n");
  let doc: any;
  try {
    doc = YAML.parseDocument(raw);
  } catch (e: any) {
    throw new Error(`ledger ${file} is not valid YAML (${e.message}) — refusing to overwrite ${raw.length} bytes`);
  }
  if (doc.errors?.length) throw new Error(`ledger ${file} has YAML errors — refusing to overwrite ${raw.length} bytes`);
  if (!doc.get("cases")) doc.set("cases", doc.createNode([]));
  return doc;
}

async function writeLedgerAtomic(file: string, doc: any): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, doc.toString());
  await rename(tmp, file); // atomic: a crash mid-write never leaves a half-rewritten reviewed corpus
}

// ── the command ──────────────────────────────────────────────────────────────

export async function ingestCases(
  config: HeyLLMConfig,
  rows: Record<string, unknown>[],
  opts: IngestOptions
): Promise<IngestResult> {
  // resolve the target layer + file (same precedence as capture)
  const capture = config.settings.capture || {};
  const layerName = opts.layer || capture.layer || config.layers.find((l) => l.kind === "judge")?.name || config.layers.find((l) => l.kind === "llm")?.name;
  if (!layerName) throw new Error("no llm/judge layer to ingest into — set settings.capture.layer");
  const relFile = opts.out || capture.file || "tests/captured.yaml";
  const file = path.resolve(config.baseDir, relFile);
  const sourceName = (opts.sourceName || "import").replace(/[^\w.-]+/g, "-");

  // validate the mapping targets
  for (const target of Object.keys(opts.map))
    if (!MAP_TARGETS.includes(target as MapTarget))
      throw new Error(`--map ${target}=… : unknown target '${target}' (valid: ${MAP_TARGETS.join(", ")})`);
  if (!opts.map.input) throw new Error("--map input=<path> is required — there is no default (auto-guessing is how rows ingest as empty prompts)");

  // map rows; collect invalid ones
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  const parsed: Row[] = [];
  const invalid: string[] = [];
  limited.forEach((raw, i) => {
    const get = (t: string) => (opts.map[t] ? deepGet(raw, opts.map[t]) : undefined);
    const input = get("input");
    if (typeof input !== "string" || !input.trim()) {
      invalid.push(`row ${i + 1}: input path '${opts.map.input}' resolved to ${input === undefined ? "nothing" : typeof input === "string" ? "empty" : typeof input}`);
      return;
    }
    const str = (t: string) => {
      const v = get(t);
      return v === undefined || v === null ? undefined : String(v);
    };
    const norm = normalizeText(input + " " + (str("expected") || ""));
    parsed.push({
      input,
      expected: str("expected"),
      steps: str("steps"),
      id: str("id"),
      url: str("url"),
      note: str("note"),
      tags: Array.isArray(get("tags")) ? (get("tags") as string[]).map(String) : undefined,
      digest: shortHash(norm),
      norm,
      grams: trigrams(norm),
      raw,
    });
  });

  if (invalid.length && !opts.skipInvalid)
    throw new Error(`${invalid.length} row(s) have no usable input — refusing to write a partial corpus (use --skip-invalid to drop them):\n  ${invalid.join("\n  ")}`);

  // dedup within the batch — exact by digest always; near (trigram) opt-in.
  const near = opts.dedup === "near";
  const threshold = opts.dedupThreshold ?? 0.85;
  const reps: { row: Row; ids: string[]; mergedRaw: string[]; duplicates: number }[] = [];
  let duplicateInBatch = 0;
  for (const row of parsed) {
    let rep = reps.find((r) => r.row.digest === row.digest);
    if (!rep && near) rep = reps.find((r) => jaccard(r.row.grams, row.grams) >= threshold);
    if (rep) {
      duplicateInBatch++;
      rep.duplicates++;
      if (row.id) rep.ids.push(row.id);
      if (row.input !== rep.row.input) rep.mergedRaw.push(row.input); // never discard evidence
    } else {
      reps.push({ row, ids: row.id ? [row.id] : [], mergedRaw: [], duplicates: 0 });
    }
  }

  // index the existing ledger for idempotency
  const doc = await readLedgerDoc(file);
  const existing = new Set<string>();
  const casesNode = doc.get("cases");
  const items = casesNode?.items ?? [];
  for (const it of items) {
    const src = it.get?.("source");
    if (src) {
      const d = src.get?.("digest");
      const sys = src.get?.("system");
      const id = src.get?.("id");
      if (d) existing.add(`digest:${d}`);
      if (sys && id) existing.add(`sid:${sys}/${id}`);
    }
  }

  const clusters: IngestResult["clusters"] = [];
  let newCases = 0;
  let alreadyInLedger = 0;
  for (const rep of reps) {
    const sidKey = rep.row.id ? `sid:${sourceName}/${rep.row.id}` : null;
    if (existing.has(`digest:${rep.row.digest}`) || (sidKey && existing.has(sidKey))) {
      alreadyInLedger++;
      continue;
    }
    const cs = buildCase(rep.row, sourceName, rep);
    clusters.push({ name: cs.name, digest: rep.row.digest, duplicates: rep.duplicates });
    if (!opts.dryRun) casesNode.add(doc.createNode(cs));
    newCases++;
  }

  if (!opts.dryRun && newCases) await writeLedgerAtomic(file, doc);

  return {
    file,
    layer: layerName,
    newCases,
    duplicateInBatch,
    alreadyInLedger,
    invalidDropped: opts.skipInvalid ? invalid.length : 0,
    clusters,
    dryRun: !!opts.dryRun,
  };
}
