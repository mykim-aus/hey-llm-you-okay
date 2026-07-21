/**
 * heyllm.yaml loader + validator.
 *
 *   version: 1
 *   providers: { name: {kind, model?, baseUrl?, apiKeyEnv?, ...} }
 *   profiles:  { name: { providers: {name: {…overrides}} } }   # --profile / HEYLLM_PROFILE
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
import { envFileVars, glob, isPlainObject, loadEnvFile } from "./util.js";
import { normalizeCompareSpec } from "./compare.js";
import { INPUTS_SYSTEM_MODES, lintInputsContract } from "./inputs.js";
import { checkDispatchMode } from "./layers/dispatch.js";
import type { CaseDef, HeyLLMConfig, LayerConfig, LayerKind, ProviderConfig, ProviderKind } from "./types.js";

export const LAYER_KINDS: LayerKind[] = ["static", "exec", "http", "llm", "judge", "dispatch"];
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
): Promise<HeyLLMConfig> {
  const file = path.resolve(configPath || "heyllm.yaml");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    err(`config not found: ${file} (run \`heyllm init\` to scaffold one)`);
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
    err(`${file}: unsupported version ${d.version} (this heyllm supports version: 1)`);

  // ── providers (+ profile overlay) ──────────────────────────────
  const providers: Record<string, ProviderConfig> = isPlainObject(d.providers)
    ? structuredClone(d.providers)
    : {};
  const profileName = profile || process.env.HEYLLM_PROFILE || null;
  if (profileName) {
    const prof = d.profiles?.[profileName];
    if (!prof)
      err(
        `${file}: profile '${profileName}' not found (defined: ${Object.keys(d.profiles || {}).join(", ") || "none"})`
      );
    for (const [name, override] of Object.entries(prof.providers || {}))
      providers[name] = { ...(providers[name] || {}), ...(override as object) } as ProviderConfig;
  }
  // provider name → the profiles that declare it, for layers that reference a
  // provider only some profile supplies.
  const profileProviders = new Map<string, string[]>();
  for (const [pname, prof] of Object.entries(d.profiles || {}))
    for (const provider of Object.keys((prof as any)?.providers || {}))
      profileProviders.set(provider, [...(profileProviders.get(provider) || []), pname]);

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
      // A provider declared only inside a profile is a legitimate reference —
      // that is how a suite keeps its paid layers out of the default run. It
      // is accepted here and enforced at run time instead, where an inactive
      // profile fails the layer loudly rather than at parse time.
      if (!providers[ref] && !profileProviders.has(ref))
        err(
          `${at}.${field}: unknown provider '${ref}' (defined: ${
            [...new Set([...Object.keys(providers), ...profileProviders.keys()])].join(", ") || "none"
          })`
        );
    }
    if (l.inputs !== undefined) {
      if (l.kind !== "llm" && l.kind !== "judge")
        err(`${at} (${l.name}): 'inputs' only applies to llm/judge layers, not '${l.kind}'`);
      if (!isPlainObject(l.inputs)) err(`${at}.inputs: must be a mapping`);
      for (const k of Object.keys(l.inputs))
        if (k !== "system") err(`${at}.inputs: unknown key '${k}' (only 'system' is supported)`);
      // An empty/half-written `inputs:` block reads as a declared contract but
      // enforces nothing — the silent-no-op shape this project rejects.
      if (l.inputs.system === undefined)
        err(`${at}.inputs: needs 'system' (${INPUTS_SYSTEM_MODES.join(" | ")}) — an empty inputs block enforces nothing`);
      if (l.inputs.system !== undefined && !INPUTS_SYSTEM_MODES.includes(l.inputs.system))
        err(`${at}.inputs.system: ${suggest(l.inputs.system, INPUTS_SYSTEM_MODES)}`);
    }
    const gate = l.gate !== undefined ? !!l.gate : !["llm", "judge"].includes(l.kind);
    return { ...l, gate } as LayerConfig;
  });

  const baseDir = path.dirname(file);
  const settings = isPlainObject(d.settings) ? (d.settings as any) : {};

  // settings.envFile — load API keys from a local .env so `heyllm run` works
  // without manual exports. Real env vars always win (CI secrets are safe).
  const envFiles: string[] = settings.envFile
    ? Array.isArray(settings.envFile)
      ? settings.envFile
      : [settings.envFile]
    : [];
  for (const rel of envFiles)
    for (const name of await loadEnvFile(path.resolve(baseDir, rel))) envFileVars.add(name);

  return { file, baseDir, version: 1, profile: profileName, providers, layers, settings };
}

export interface CaseGroup {
  file: string | null;
  cases: CaseDef[];
}

/** Load a layer's case files (include globs + inline cases). */
export async function loadLayerCases(
  layer: LayerConfig,
  baseDir: string,
  /** settings.capture.file — exempt, since it exists only after `heyllm capture` */
  captureRel?: string
): Promise<CaseGroup[]> {
  const groups: CaseGroup[] = [];
  if (layer.cases) groups.push({ file: null, cases: layer.cases });
  const patterns = Array.isArray(layer.include) ? layer.include : layer.include ? [layer.include] : [];
  const files: string[] = [];
  // Check EVERY pattern, not just the aggregate. A layer with several includes
  // used to swallow a typo in any one of them as long as a sibling matched —
  // coverage silently dropped to whatever was left, and the run stayed green.
  // (Measured: a real config referenced a case file that did not exist; the
  // layer reported PASS for months.) A single missing include already errored;
  // this makes the list case behave the same way instead of the opposite way.
  const unmatched: string[] = [];
  for (const pat of patterns) {
    const hits = await glob(pat, baseDir);
    if (!hits.length) unmatched.push(pat);
    files.push(...hits);
  }
  if (patterns.length && !files.length && !layer.cases)
    err(`layer '${layer.name}': include matched no files (${patterns.join(", ")}) under ${baseDir}`);
  // The capture target is legitimately absent until `heyllm capture` writes it.
  const captureFile = captureRel ? path.resolve(baseDir, captureRel) : null;
  const real = unmatched.filter((pat) => !captureFile || path.resolve(baseDir, pat) !== captureFile);
  if (real.length)
    err(
      `layer '${layer.name}': include matched no files: ${real.join(", ")} (under ${baseDir}). ` +
        `Remove the pattern or fix the path — a silently empty include hides missing coverage.`
    );
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
// `source` is one nested mapping, not flat keys: `file` is claimed by static,
// `input`/`context` by judge, `note`/`capturedAt` are already here — a flat
// id/url would collide the moment a new kind wants those names. One nested key
// verified absent from every KIND_KEYS list costs a single COMMON entry.
const COMMON_KEYS = ["name", "tags", "skip", "note", "capturedAt", "expect", "source", "fingerprintIgnore"];
// The file-mode static keys — mutually exclusive with `compare:`.
const STATIC_FILE_KEYS = ["file", "files", "mustExist", "forbid", "require", "jsonValid", "yamlValid", "maxBytes"];

const KIND_KEYS: Record<string, string[]> = {
  static: ["file", "files", "mustExist", "forbid", "require", "jsonValid", "yamlValid", "maxBytes", "compare"],
  exec: ["command", "cwd", "env", "timeoutMs"],
  http: ["request", "save"],
  llm: ["system", "prompt", "messages", "conversation", "tools", "toolResponses", "params", "maxRounds", "repeat", "passRate", "dispatch"],
  judge: ["input", "output", "transcript", "context", "rubric", "scale", "votes", "threshold", "minScores", "judgeParams", "reliability"],
  dispatch: ["module", "export", "command", "args", "cwd", "env", "timeoutMs", "initialState", "calls"],
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
      // Pre-flight the layer's input contract on the REF FORM in YAML — zero
      // model calls, catches an absent/inline system prompt before a token is
      // spent. Run time re-checks the resolved bytes (a builder that prints
      // nothing), which validate cannot see.
      for (const p of lintInputsContract(layer, cs, at)) problems.push(p);
      // Un-skip enforcement for ingested rows. A skipped stub is fine (it is
      // reported as UNVERIFIED, not a pass). But the moment a reviewer removes
      // `skip:`, the case must be actually finished: no TODO markers left, and
      // it must carry an assertion. This is what stops a 275-row backlog from
      // being un-skipped into 275 vacuous green ticks.
      if (isPlainObject(cs.source) && !cs.skip) {
        const blob = JSON.stringify(cs);
        if (/TODO/.test(blob))
          need(false, g.file, cs, `ingested case still has TODO markers but is no longer skipped — finish the rubric/rules or restore skip:`);
        if (layer.kind === "llm" && !cs.expect && !cs.conversation)
          need(false, g.file, cs, `ingested llm case has no 'expect' — an assertion-less case is a vacuous pass; add expect: or keep skip:`);
        if (layer.kind === "judge" && !cs.rubric)
          need(false, g.file, cs, `ingested judge case has no 'rubric' — add one or keep skip:`);
      }
      for (const key of Object.keys(cs))
        if (!allowed.has(key))
          problems.push(
            `${g.file || "(inline)"} › ${cs.name}: unknown key '${key}' for a ${layer.kind} case (typo or mis-indented block? allowed: ${[...allowed].join(", ")})`
          );
      switch (layer.kind) {
        case "static":
          need(cs.file || cs.files || cs.compare, g.file, cs, "needs 'file', 'files' or 'compare'");
          if (cs.compare) {
            // A compare case has no glob, so a file-mode key next to it would
            // apply to nothing — the assertion silently pointed at the wrong
            // target, the exact bug class compare exists to catch. Reject it.
            const clash = STATIC_FILE_KEYS.filter((k) => k in cs);
            if (clash.length)
              need(false, g.file, cs, `'compare' cannot be combined with ${clash.join(", ")} — a compare case has no file glob, so those would apply to nothing. Split into two cases.`);
            const spec = normalizeCompareSpec(cs.compare, at);
            if (Array.isArray(spec)) for (const p of spec) problems.push(p);
          }
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
        case "dispatch": {
          const modeProblem = checkDispatchMode(cs);
          if (modeProblem) need(false, g.file, cs, modeProblem);
          need(Array.isArray(cs.calls) && cs.calls.length, g.file, cs, "needs a non-empty 'calls' array");
          // No `expect` means the reducer runs and nothing is checked — a green
          // tick that verified nothing, the same vacuous-pass shape as an
          // assertion-less llm case.
          need(cs.expect !== undefined, g.file, cs, "needs 'expect' — a dispatch case with no assertion passes without verifying anything");
          break;
        }
        case "judge":
          need(Array.isArray(cs.rubric) && cs.rubric.length, g.file, cs, "needs a non-empty 'rubric'");
          need(cs.input || cs.output || cs.transcript, g.file, cs, "needs 'input' (subject call), 'output' or 'transcript'");
          for (const r of cs.rubric || []) {
            need(r.id && r.question, g.file, cs, "every rubric item needs 'id' and 'question'");
            need(!r.ask || ["scale", "binary"].includes(r.ask), g.file, cs, `rubric '${r.id}': ask must be 'scale' or 'binary'`);
          }
          break;
      }
    }
  }
  return problems;
}
