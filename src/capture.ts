/**
 * Self-Growing Corpus Ledger — `heyllm capture "<input>"`.
 *
 * Promote a real-world failure (production complaint, false positive, QA
 * report) into the golden scenario corpus with one command. The ledger is a
 * normal case file: version-controlled, reviewed in PRs, and run on every
 * subsequent `heyllm run` forever.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { glob } from "./util.js";
import type { CaseDef, HeyLLMConfig } from "./types.js";

export interface CaptureOptions {
  name?: string;
  tags?: string[];
  note?: string;
  /** target layer name (default: settings.capture.layer or first llm layer) */
  layer?: string;
}

export async function captureCase(
  config: HeyLLMConfig,
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
    throw new Error("no llm/judge layer to capture into — set settings.capture.layer in heyllm.yaml");
  const layer = config.layers.find((l) => l.name === layerName);
  if (!layer) throw new Error(`capture layer '${layerName}' not found`);

  const relFile = capture.file || "tests/captured.yaml";
  const file = path.resolve(config.baseDir, relFile);

  // A missing ledger is fine (first capture). A MALFORMED ledger must abort —
  // silently starting a fresh doc would overwrite the whole captured corpus.
  // parseDocument (not parse+stringify) so a reviewer's comments — "# confirmed
  // with CS, root cause is the retrieval prompt" — survive the round trip.
  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ledger ${relFile}: ${e.message}`);
  }
  let doc: any;
  if (raw === null) {
    doc = YAML.parseDocument("cases: []\n");
  } else {
    doc = YAML.parseDocument(raw);
    if (doc.errors?.length)
      throw new Error(`ledger ${relFile} is not valid YAML — fix it before capturing, refusing to overwrite ${raw.length} bytes`);
    const casesNode = doc.get("cases");
    if (!casesNode) {
      if (raw.trim()) throw new Error(`ledger ${relFile} has no 'cases' array — refusing to overwrite it`);
      doc.set("cases", doc.createNode([]));
    }
  }
  const cases: CaseDef[] = (doc.get("cases")?.toJSON() as CaseDef[]) || [];

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = cases.filter((c) => c.name?.startsWith(`captured-${today}`)).length + 1;
  const caseName = opts.name || `captured-${today}-${String(seq).padStart(2, "0")}`;
  if (cases.some((c) => c.name === caseName))
    throw new Error(`case '${caseName}' already exists in ${relFile}`);

  const entry: CaseDef = {
    name: caseName,
    tags: ["captured", ...(opts.tags || [])],
    ...(opts.note ? { note: opts.note } : {}),
    capturedAt: new Date().toISOString(),
    ...(capture.defaults || {}),
    ...(layer.kind === "judge" ? { input: { prompt: input } } : { prompt: input }),
  };
  doc.get("cases").add(doc.createNode(entry));

  await mkdir(path.dirname(file), { recursive: true });
  // atomic: a crash mid-write must never leave a half-rewritten reviewed corpus
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, doc.toString());
  await rename(tmp, file);

  // A captured case that no include glob matches would never run — the whole
  // point of the ledger. Verify reachability and report it to the caller.
  const patterns = Array.isArray(layer.include) ? layer.include : layer.include ? [layer.include] : [];
  const matched: string[] = [];
  for (const pat of patterns) matched.push(...(await glob(pat, config.baseDir)));
  const reachable = matched.some((m) => path.resolve(m) === path.resolve(file));

  return { file, caseName, layer: layerName, reachable, patterns };
}
