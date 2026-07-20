/**
 * haechi.yaml loader + validator.
 *
 *   version: 1
 *   providers: { name: {kind, model?, baseUrl?, apiKeyEnv?, ...} }
 *   profiles:  { name: { providers: {name: {…overrides}} } }   # --profile / HAECHI_PROFILE
 *   settings:  { maxDrop?, triage?: {repeat, source, gitRef}, capture?: {file, layer, defaults} }
 *   layers:    [ {name, kind, include|cases, gate?, provider|subject+judge, env?, vars?, ...} ]
 *
 * Gate default: true for static/exec/http (deterministic), false for llm/judge
 * (sampling-noisy). A failing gated layer HALTS the pyramid — later, more
 * expensive layers are not burned.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { glob, isPlainObject, loadEnvFile } from "./util.js";
import type { CaseDef, HaechiConfig, LayerConfig, LayerKind, ProviderConfig, ProviderKind } from "./types.js";

export const LAYER_KINDS: LayerKind[] = ["static", "exec", "http", "llm", "judge"];
export const PROVIDER_KINDS: ProviderKind[] = ["openai-compatible", "anthropic", "gemini", "command"];

export class ConfigError extends Error {}

function err(msg: string): never {
  throw new ConfigError(msg);
}

const suggest = (value: unknown, valid: string[]) =>
  `'${value}' is not valid — expected one of: ${valid.join(", ")}`;

export async function loadConfig(
  configPath?: string,
  { profile }: { profile?: string } = {}
): Promise<HaechiConfig> {
  const file = path.resolve(configPath || "haechi.yaml");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    err(`config not found: ${file} (run \`haechi init\` to scaffold one)`);
  }
  let doc: any;
  try {
    doc = YAML.parse(raw);
  } catch (e: any) {
    err(`YAML parse error in ${file}: ${e.message}`);
  }
  if (!isPlainObject(doc)) err(`${file}: top level must be a mapping`);
  const d: any = doc; // validated mapping; YAML-shaped access below stays loose
  if (d.version !== undefined && d.version !== 1)
    err(`${file}: unsupported version ${d.version} (this haechi supports version: 1)`);

  // ── providers (+ profile overlay) ──────────────────────────────
  const providers: Record<string, ProviderConfig> = isPlainObject(d.providers)
    ? structuredClone(d.providers)
    : {};
  const profileName = profile || process.env.HAECHI_PROFILE || null;
  if (profileName) {
    const prof = d.profiles?.[profileName];
    if (!prof)
      err(
        `${file}: profile '${profileName}' not found (defined: ${Object.keys(d.profiles || {}).join(", ") || "none"})`
      );
    for (const [name, override] of Object.entries(prof.providers || {}))
      providers[name] = { ...(providers[name] || {}), ...(override as object) } as ProviderConfig;
  }
  for (const [name, p] of Object.entries(providers)) {
    if (!isPlainObject(p)) err(`providers.${name}: must be a mapping`);
    if (!PROVIDER_KINDS.includes(p.kind)) err(`providers.${name}.kind: ${suggest(p.kind, PROVIDER_KINDS)}`);
    if (p.kind === "command" && !p.command) err(`providers.${name}: kind 'command' requires 'command'`);
    if (p.kind !== "command" && !p.model) err(`providers.${name}: kind '${p.kind}' requires 'model'`);
    if ((p as any).apiKey)
      err(`providers.${name}: never put raw keys in YAML — use apiKeyEnv: ENV_VAR_NAME`);
  }

  // ── layers ─────────────────────────────────────────────────────
  if (!Array.isArray(d.layers) || !d.layers.length)
    err(`${file}: 'layers' must be a non-empty array`);
  const seen = new Set<string>();
  const layers: LayerConfig[] = d.layers.map((raw: unknown, i: number) => {
    const at = `layers[${i}]`;
    if (!isPlainObject(raw)) err(`${at}: must be a mapping`);
    const l: any = raw;
    if (!l.name) err(`${at}: 'name' is required`);
    if (seen.has(l.name)) err(`${at}: duplicate layer name '${l.name}'`);
    seen.add(l.name);
    if (!LAYER_KINDS.includes(l.kind)) err(`${at}.kind: ${suggest(l.kind, LAYER_KINDS)}`);
    if (!l.include && !l.cases) err(`${at} (${l.name}): needs 'include' globs or inline 'cases'`);
    const needsProvider: string[] =
      ({ llm: ["provider"], judge: ["subject", "judge"] } as Record<string, string[]>)[l.kind] || [];
    for (const field of needsProvider) {
      const ref = l[field];
      if (!ref) err(`${at} (${l.name}): '${field}' provider reference is required for kind '${l.kind}'`);
      if (!providers[ref])
        err(`${at}.${field}: unknown provider '${ref}' (defined: ${Object.keys(providers).join(", ") || "none"})`);
    }
    const gate = l.gate !== undefined ? !!l.gate : !["llm", "judge"].includes(l.kind);
    return { ...l, gate } as LayerConfig;
  });

  const baseDir = path.dirname(file);
  const settings = isPlainObject(d.settings) ? (d.settings as any) : {};

  // settings.envFile — load API keys from a local .env so `haechi run` works
  // without manual exports. Real env vars always win (CI secrets are safe).
  const envFiles: string[] = settings.envFile
    ? Array.isArray(settings.envFile)
      ? settings.envFile
      : [settings.envFile]
    : [];
  for (const rel of envFiles) await loadEnvFile(path.resolve(baseDir, rel));

  return { file, baseDir, version: 1, profile: profileName, providers, layers, settings };
}

export interface CaseGroup {
  file: string | null;
  cases: CaseDef[];
}

/** Load a layer's case files (include globs + inline cases). */
export async function loadLayerCases(layer: LayerConfig, baseDir: string): Promise<CaseGroup[]> {
  const groups: CaseGroup[] = [];
  if (layer.cases) groups.push({ file: null, cases: layer.cases });
  const patterns = Array.isArray(layer.include) ? layer.include : layer.include ? [layer.include] : [];
  const files: string[] = [];
  for (const pat of patterns) files.push(...(await glob(pat, baseDir)));
  if (patterns.length && !files.length && !layer.cases)
    err(`layer '${layer.name}': include matched no files (${patterns.join(", ")}) under ${baseDir}`);
  for (const f of [...new Set(files)]) {
    let doc: any;
    try {
      doc = YAML.parse(await readFile(f, "utf8"));
    } catch (e: any) {
      err(`${f}: YAML parse error: ${e.message}`);
    }
    if (doc?.kind && doc.kind !== layer.kind)
      err(`${f}: file kind '${doc.kind}' does not match layer '${layer.name}' kind '${layer.kind}'`);
    if (!Array.isArray(doc?.cases)) err(`${f}: expected a top-level 'cases' array`);
    for (const cs of doc.cases) if (!cs?.name) err(`${f}: every case needs a 'name'`);
    groups.push({ file: f, cases: doc.cases });
  }
  const names = new Set<string>();
  for (const g of groups)
    for (const cs of g.cases) {
      if (names.has(cs.name))
        err(
          `layer '${layer.name}': duplicate case name '${cs.name}' (names must be unique per layer — triage/baseline keys depend on it)`
        );
      names.add(cs.name);
    }
  return groups;
}

/** Keys a case may carry, per layer kind. An unknown key is almost always a
 *  typo or a mis-indented block (e.g. `expect` nested one level too deep),
 *  which would leave the case asserting NOTHING and passing forever. */
const COMMON_KEYS = ["name", "tags", "skip", "note", "capturedAt", "expect"];
const KIND_KEYS: Record<string, string[]> = {
  static: ["file", "files", "mustExist", "forbid", "require", "jsonValid", "yamlValid", "maxBytes"],
  exec: ["command", "cwd", "env", "timeoutMs"],
  http: ["request", "save"],
  llm: ["system", "prompt", "messages", "conversation", "tools", "toolResponses", "params", "maxRounds", "repeat", "passRate"],
  judge: ["input", "output", "transcript", "context", "rubric", "scale", "votes", "threshold", "minScores", "judgeParams"],
};

/**
 * Compile every $pattern/$notPattern in an expect tree so a bad regex is an
 * authoring error found by `validate` — not a runtime failure discovered after
 * `repeat` paid model calls.
 */
export function lintExpectRegexes(node: unknown, where: string, problems: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) lintExpectRegexes(v, where, problems);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of ["$pattern", "$notPattern"] as const) {
    if (typeof node[key] === "string") {
      try {
        new RegExp(node[key] as string, typeof node.$flags === "string" ? node.$flags : "");
      } catch (e: any) {
        problems.push(
          `${where}: invalid ${key} /${node[key]}/ — ${e.message} (JS has no inline (?i); use $flags: "i")`
        );
      }
    }
  }
  for (const v of Object.values(node)) lintExpectRegexes(v, where, problems);
}

/** Per-kind required-field + unknown-key + regex lint. Returns problem strings. */
export function validateCases(layer: LayerConfig, groups: CaseGroup[]): string[] {
  const problems: string[] = [];
  const need = (cond: unknown, file: string | null, cs: CaseDef, msg: string) => {
    if (!cond) problems.push(`${file || "(inline)"} › ${cs.name}: ${msg}`);
  };
  const allowed = new Set([...COMMON_KEYS, ...(KIND_KEYS[layer.kind] || [])]);
  for (const g of groups) {
    for (const cs of g.cases) {
      const at = `${g.file || "(inline)"} › ${cs.name}`;
      lintExpectRegexes(cs.expect, at, problems);
      lintExpectRegexes(cs.forbid, at, problems);
      lintExpectRegexes(cs.require, at, problems);
      for (const turn of cs.conversation || []) lintExpectRegexes(turn?.expect, at, problems);
      for (const key of Object.keys(cs))
        if (!allowed.has(key))
          problems.push(
            `${g.file || "(inline)"} › ${cs.name}: unknown key '${key}' for a ${layer.kind} case (typo or mis-indented block? allowed: ${[...allowed].join(", ")})`
          );
      switch (layer.kind) {
        case "static":
          need(cs.file || cs.files, g.file, cs, "needs 'file' or 'files'");
          break;
        case "exec":
          need(cs.command, g.file, cs, "needs 'command'");
          break;
        case "http":
          need(cs.request?.url, g.file, cs, "needs 'request.url'");
          break;
        case "llm":
          need(cs.prompt || cs.messages || cs.conversation, g.file, cs, "needs 'prompt', 'messages' or 'conversation'");
          break;
        case "judge":
          need(Array.isArray(cs.rubric) && cs.rubric.length, g.file, cs, "needs a non-empty 'rubric'");
          need(cs.input || cs.output || cs.transcript, g.file, cs, "needs 'input' (subject call), 'output' or 'transcript'");
          for (const r of cs.rubric || [])
            need(r.id && r.question, g.file, cs, "every rubric item needs 'id' and 'question'");
          break;
      }
    }
  }
  return problems;
}
