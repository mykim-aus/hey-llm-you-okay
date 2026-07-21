/**
 * Input-provenance contract — make heyllm notice when a test is NOT exercising
 * the prompt production actually assembles.
 *
 * The case study's transferable lesson: "a test that builds its own prompt is
 * testing a program you do not ship." Real incident that motivated this: a
 * routing suite whose llm cases sent NO system prompt while production assembles
 * an 83,621-char one — all cases passed, the tool was silent.
 *
 * What separates a faithful test from a fake one is WHERE the system prompt came
 * from, and heyllm already owns that fact (resolveRef classifies exec:/file:/
 * literal). This exposes it, three ways, deliberately asymmetric in loudness:
 *
 *   census   — `heyllm validate` prints provenance per layer. A fact, never a
 *              verdict, so it can never train anyone to ignore it.
 *   contract — opt-in `inputs: { system: file|exec|required }` on a layer; a
 *              hard error, checked at BOTH validate time (ref form) and run time
 *              (so it fires on `heyllm run`, which never calls the validator).
 *   floor    — unconditional: a file:/exec: system ref that resolves to 0 bytes
 *              is always an error. There is no legitimate reading of "I asked a
 *              ref for a prompt and got nothing", so it needs no opt-in.
 *
 * Deliberately dropped in review: `minSystemBytes` (the case study says outright
 * size was not the problem — a byte floor would have gone green on Bug 1) and a
 * `system: "any"` mode (enforces nothing but reads as a declared claim).
 */
import type { CaseDef, Failure, LayerConfig, LayerKind, ResolvedLlmInputs } from "./types.js";

export type SystemSource = "absent" | "inline" | "file" | "exec";
export type InputsSystemMode = "required" | "file" | "exec";
// plain string[] (not `as const`) so it drops straight into config.ts's suggest()
export const INPUTS_SYSTEM_MODES: string[] = ["required", "file", "exec"];

export class InputContractError extends Error {}

/**
 * Classify one system-prompt VALUE. Must be given the value AFTER {{var}}
 * interpolation and BEFORE ref resolution: `system: "{{PROMPT}}"` where the var
 * expands to `file:…` used to classify as `inline`, which both rejected a valid
 * case under `system: file` and — worse — disabled the 0-byte floor for it.
 * After ref resolution an exec: result and a hand-typed literal are both just a
 * string, so this is the only point where provenance exists.
 */
export function classifySystem(raw: unknown): SystemSource {
  if (raw === undefined || raw === null) return "absent";
  if (typeof raw !== "string") return "inline";
  if (!raw.trim()) return "absent"; // whitespace-only is not a prompt
  if (raw.startsWith("exec:")) return "exec";
  if (raw.startsWith("file:")) return "file";
  return "inline";
}

/**
 * A judge case that supplies `output:`/`transcript:` never calls the subject, so
 * it has no system prompt to constrain. getSubjectOutput returns on those BEFORE
 * touching `input:`, so the exemption must key on the same precedence — keying
 * on `input === undefined` made validate reject a case that run exempted.
 */
export function isJudgeExempt(cs: CaseDef, kind: LayerKind): boolean {
  return kind === "judge" && (cs.output !== undefined || cs.transcript !== undefined || cs.input === undefined);
}

/** Provenance read off the YAML, for lint and census. */
export function systemSource(cs: CaseDef, kind: LayerKind): SystemSource {
  return classifySystem(kind === "judge" ? cs.input?.system : cs.system);
}

/** True when the YAML value still contains an un-expanded {{var}} — provenance
 *  is not knowable until run time, so validate must not guess. */
export function isInterpolated(cs: CaseDef, kind: LayerKind): boolean {
  const raw = kind === "judge" ? cs.input?.system : cs.system;
  return typeof raw === "string" && /\{\{[^}]+\}\}/.test(raw);
}

// Whether a source satisfies a declared mode.
function sourceSatisfies(source: SystemSource, mode: InputsSystemMode): boolean {
  if (source === "absent") return false;
  if (mode === "required") return true; // any non-empty, incl. inline
  if (mode === "file") return source === "file" || source === "exec";
  return source === "exec"; // mode === "exec"
}

function contractOf(layer: LayerConfig): InputsSystemMode | null {
  if ((layer.kind !== "llm" && layer.kind !== "judge") || !layer.inputs?.system) return null;
  return layer.inputs.system as InputsSystemMode;
}

const fixHint = (mode: InputsSystemMode) =>
  mode === "exec"
    ? "Point system: at an exec: ref of your prompt builder (the code production runs)."
    : mode === "file"
      ? "Point system: at a file: or exec: ref."
      : "Give the case a non-empty system prompt, or move it to a layer without this contract.";

/**
 * Validate-time check on the REF FORM written in YAML. Zero model calls. Returns
 * [] when the layer declared no contract — a suite that made no claim gets no
 * verdict. A judge case with no `input:` (an output:/transcript: case) is exempt:
 * it has no subject prompt to constrain.
 */
export function lintInputsContract(layer: LayerConfig, cs: CaseDef, at: string): string[] {
  const mode = contractOf(layer);
  if (!mode) return [];
  if (isJudgeExempt(cs, layer.kind)) return [];
  // An un-expanded {{var}} is only knowable at run time; guessing here would
  // reject valid cases. checkInputContract re-runs this on the expanded value.
  if (isInterpolated(cs, layer.kind)) return [];
  const source = systemSource(cs, layer.kind);
  if (!sourceSatisfies(source, mode as InputsSystemMode))
    return [
      `${at}: layer '${layer.name}' declares inputs.system: ${mode}, but this case's system prompt is ${source === "absent" ? "absent" : `an ${source} value`} — it is not the prompt production assembles. ${fixHint(mode as InputsSystemMode)}`,
    ];
  return [];
}

/**
 * Run-time check on the RESOLVED inputs. Three rules, deliberately different in
 * scope, none subsuming another:
 *   Rule 1 (unconditional): a file:/exec: system ref that resolved to empty ran
 *           the case with NO system prompt while declaring one.
 *   Rule 2 (only when the layer declares a contract): re-enforces the mode from
 *           provenance, so the contract fires on `heyllm run` — which never
 *           calls the validator.
 *   Rule 3 (only when the layer declares inputs.mustContain): the resolved
 *           system must contain each named marker. Catches a builder that
 *           SUCCEEDS but emits a degraded prompt — measured: a dead DB cost a
 *           prompt its whole case-list section at exit 0, and the 0-byte floor
 *           (rule 1) could not see it because 54k bytes came back.
 */
export function checkInputContract(cs: CaseDef, inputs: ResolvedLlmInputs, layer: LayerConfig): Failure[] {
  if (isJudgeExempt(cs, layer.kind)) return [];
  // Classify from the value resolveLlmInputs actually interpolated, not the raw
  // YAML — otherwise `system: "{{PROMPT}}"` expanding to a file: ref is read as
  // an inline literal and the 0-byte floor never fires for it.
  const source = classifySystem(inputs.systemRef ?? (layer.kind === "judge" ? cs.input?.system : cs.system));
  const fails: Failure[] = [];

  // Rule 1 — the floor. A ref was given; nothing came back.
  if ((source === "file" || source === "exec") && !(inputs.system ?? "").trim())
    fails.push({
      path: "inputs.system",
      message: `system: resolved to 0 bytes — this case ran with NO system prompt while declaring one. A test that builds its own prompt is testing a program you do not ship.`,
    });

  // Rule 2 — the declared contract, re-checked at run time.
  const mode = contractOf(layer);
  if (mode && !sourceSatisfies(source, mode as InputsSystemMode))
    fails.push({
      path: "inputs.system",
      message: `layer '${layer.name}' declares inputs.system: ${mode}, but this case's system prompt is ${source === "absent" ? "absent" : `an ${source} value`}. ${fixHint(mode as InputsSystemMode)}`,
    });

  // Rule 3 — content completeness. A ref that resolves non-empty can still be
  // a prompt production never sends (builder degraded: DB down, feature-flagged
  // section, partial assembly). Substring, not regex: the marker is meant to be
  // a verbatim quote from the prompt, and regex escaping errors here would fail
  // toward "always matches" — the silent-green direction.
  const markers = layer.inputs?.mustContain;
  if (markers?.length) {
    const sys = inputs.system ?? "";
    for (const m of markers)
      if (!sys.includes(m))
        fails.push({
          path: "inputs.mustContain",
          message: `resolved system prompt is missing the declared marker ${JSON.stringify(m)} (${sys.length} chars came back). The builder succeeded but emitted a DEGRADED prompt — a section production assembles is absent, so running this case would test a program you do not ship.`,
        });
  }

  return fails;
}

/** Census for `heyllm validate` — a fact, never a verdict. */
export function censusSystemSources(kind: LayerKind, cases: CaseDef[]): Record<SystemSource, number> {
  const counts: Record<SystemSource, number> = { exec: 0, file: 0, inline: 0, absent: 0 };
  for (const cs of cases) counts[systemSource(cs, kind)]++;
  return counts;
}

/** Ordered closest-to-production first; non-zero buckets only. */
export function formatSystemCensus(counts: Record<SystemSource, number>): string {
  const order: SystemSource[] = ["exec", "file", "inline", "absent"];
  const bits = order.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return bits.length ? bits.join(", ") : "none";
}
