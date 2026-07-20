/**
 * Self-Growing Corpus Ledger — `haechi capture "<input>"`.
 *
 * Promote a real-world failure (production complaint, false positive, QA
 * report) into the golden scenario corpus with one command. The ledger is a
 * normal case file: version-controlled, reviewed in PRs, and run on every
 * subsequent `haechi run` forever.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { glob } from "./util.js";
import type { CaseDef, HaechiConfig } from "./types.js";

export interface CaptureOptions {
  name?: string;
  tags?: string[];
  note?: string;
  /** target layer name (default: settings.capture.layer or first llm layer) */
  layer?: string;
}

export async function captureCase(
  config: HaechiConfig,
  input: string,
  opts: CaptureOptions = {}
): Promise<{ file: string; caseName: string; layer: string; reachable: boolean; patterns: string[] }> {
  const capture = config.settings.capture || {};
  const layerName =
    opts.layer ||
    capture.layer ||
    config.layers.find((l) => l.kind === "llm")?.name ||
    config.layers.find((l) => l.kind === "judge")?.name;
  if (!layerName)
    throw new Error("no llm/judge layer to capture into — set settings.capture.layer in haechi.yaml");
  const layer = config.layers.find((l) => l.name === layerName);
  if (!layer) throw new Error(`capture layer '${layerName}' not found`);

  const relFile = capture.file || "tests/captured.yaml";
  const file = path.resolve(config.baseDir, relFile);

  // A missing ledger is fine (first capture). A MALFORMED ledger must abort —
  // silently starting a fresh doc would overwrite the whole captured corpus.
  let doc: { kind?: string; cases: CaseDef[] };
  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ledger ${relFile}: ${e.message}`);
  }
  if (raw === null) {
    doc = { kind: layer.kind, cases: [] };
  } else {
    let parsed: any;
    try {
      parsed = YAML.parse(raw);
    } catch (e: any) {
      throw new Error(
        `ledger ${relFile} is not valid YAML (${e.message}) — fix it before capturing, refusing to overwrite ${raw.length} bytes`
      );
    }
    doc = parsed || { kind: layer.kind, cases: [] };
    if (!Array.isArray(doc.cases)) {
      if (parsed && Object.keys(parsed).length)
        throw new Error(`ledger ${relFile} has no 'cases' array — refusing to overwrite it`);
      doc.cases = [];
    }
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = doc.cases.filter((c) => c.name?.startsWith(`captured-${today}`)).length + 1;
  const caseName = opts.name || `captured-${today}-${String(seq).padStart(2, "0")}`;
  if (doc.cases.some((c) => c.name === caseName))
    throw new Error(`case '${caseName}' already exists in ${relFile}`);

  const entry: CaseDef = {
    name: caseName,
    tags: ["captured", ...(opts.tags || [])],
    ...(opts.note ? { note: opts.note } : {}),
    capturedAt: new Date().toISOString(),
    ...(capture.defaults || {}),
    ...(layer.kind === "judge" ? { input: { prompt: input } } : { prompt: input }),
  };
  doc.cases.push(entry);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, YAML.stringify(doc));

  // A captured case that no include glob matches would never run — the whole
  // point of the ledger. Verify reachability and report it to the caller.
  const patterns = Array.isArray(layer.include) ? layer.include : layer.include ? [layer.include] : [];
  const matched: string[] = [];
  for (const pat of patterns) matched.push(...(await glob(pat, config.baseDir)));
  const reachable = matched.some((m) => path.resolve(m) === path.resolve(file));

  return { file, caseName, layer: layerName, reachable, patterns };
}
