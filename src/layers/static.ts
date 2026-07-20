/**
 * static layer — the cheapest gate. No network, no LLM. Typo/forbidden
 * patterns, required patterns, JSON/YAML validity, existence, size.
 * Belongs first in the pyramid: milliseconds, deterministic, free.
 */
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";
import { glob, resolveRef, truncate } from "../util.js";
import { normalizeCompareSpec, runCompare, formatCompareReport, summarizeCompare } from "../compare.js";

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

interface Rule {
  pattern: string;
  flags?: string;
  message?: string;
}
const normRules = (rules: unknown): Rule[] =>
  ((rules as any[]) || []).map((r) => (typeof r === "string" ? { pattern: r } : r));

export async function runStaticCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  // A compare case has no glob — branch before the file-loop machinery below,
  // which would otherwise call glob(undefined) and throw.
  if (cs.compare) return runCompareCase(cs, ctx);
  const failures: Failure[] = [];
  const patterns: string[] = cs.files ? (Array.isArray(cs.files) ? cs.files : [cs.files]) : [cs.file];
  const files: string[] = [];
  for (const p of patterns) files.push(...(await glob(p, ctx.baseDir)));

  if (!files.length) {
    if (cs.mustExist !== false)
      failures.push({ path: "files", message: `no files matched: ${patterns.join(", ")}` });
    return { ok: !failures.length, failures };
  }

  for (const f of files) {
    let content: string;
    try {
      content = await readFile(f, "utf8");
    } catch (e: any) {
      failures.push({ path: f, message: `unreadable: ${e.message}` });
      continue;
    }
    if (cs.maxBytes && Buffer.byteLength(content) > cs.maxBytes)
      failures.push({ path: f, message: `exceeds maxBytes ${cs.maxBytes} (${Buffer.byteLength(content)})` });
    if (cs.jsonValid) {
      try {
        JSON.parse(content);
      } catch (e: any) {
        failures.push({ path: f, message: `invalid JSON: ${e.message}` });
      }
    }
    if (cs.yamlValid) {
      try {
        YAML.parse(content);
      } catch (e: any) {
        failures.push({ path: f, message: `invalid YAML: ${e.message}` });
      }
    }
    for (const rule of normRules(cs.forbid)) {
      const flags = (rule.flags || "") + ((rule.flags || "").includes("g") ? "" : "g");
      for (const m of content.matchAll(new RegExp(rule.pattern, flags))) {
        failures.push({
          path: `${f}:${lineOf(content, m.index ?? 0)}`,
          message: rule.message || `forbidden pattern /${rule.pattern}/ found: "${truncate(m[0], 80)}"`,
        });
      }
    }
    for (const rule of normRules(cs.require)) {
      if (!new RegExp(rule.pattern, rule.flags || "").test(content))
        failures.push({ path: f, message: rule.message || `required pattern /${rule.pattern}/ not found` });
    }
  }
  return { ok: !failures.length, failures, detail: { files: files.length } };
}

const MAX_COMPARE_BYTES = 4 * 1024 * 1024;

async function runCompareCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  // Defence in depth: `validate` already caught a malformed spec, but `run`
  // never calls the validator, so re-normalize here before proceeding.
  const spec = normalizeCompareSpec(cs.compare, cs.name);
  if (Array.isArray(spec)) return { ok: false, failures: spec.map((m) => ({ path: "compare", message: m })) };

  // Resolve each side. file: dir vs project root for exec: — the documented rule
  // (same as the llm layer). A missing file or a non-zero exec: exit is always a
  // hard failure here; `mustExist: false` does not apply to compare. Exit 1, not
  // 2 — a crashing prompt-builder is a deterministic broken build, not "we never
  // got to ask", so it is NOT tagged infra.
  const resolveSide = async (side: "left" | "right"): Promise<{ value: unknown } | { fail: Failure }> => {
    try {
      return { value: await resolveRef((spec as any)[side], ctx.baseDir, ctx.config.baseDir) };
    } catch (e: any) {
      return { fail: { path: `compare.${side}`, message: `could not resolve ${(spec as any)[side]}: ${e.message}` } };
    }
  };
  const [l, r] = await Promise.all([resolveSide("left"), resolveSide("right")]);
  const fails: Failure[] = [];
  if ("fail" in l) fails.push(l.fail);
  if ("fail" in r) fails.push(r.fail);
  if (fails.length) return { ok: false, failures: fails };

  const lv = (l as any).value;
  const rv = (r as any).value;
  // A file: ref ending in .json resolves to a parsed object; a mixed object-vs-
  // string pair would deep-compare nonsense. Reject it with a typed error rather
  // than emitting a diff of an object against text.
  if (typeof lv !== "string" || typeof rv !== "string")
    return {
      ok: false,
      failures: [{ path: "compare", message: `compare needs two text refs, but ${typeof lv !== "string" ? "left" : "right"} resolved to ${typeof (typeof lv !== "string" ? lv : rv)} (a file: ref ending .json is parsed — point it at a text file)` }],
    };
  if (lv.length > MAX_COMPARE_BYTES || rv.length > MAX_COMPARE_BYTES)
    return { ok: false, failures: [{ path: "compare", message: `compare input exceeds ${MAX_COMPARE_BYTES} bytes — too large to diff` }] };
  // Empty floor (B5): a builder that logs to stderr and prints nothing resolves
  // to '' after resolveRef's trim; against an empty/emptied fixture that is
  // byte-identical and would go green having verified nothing.
  if (!lv.trim() || !rv.trim())
    return {
      ok: false,
      failures: [{ path: "compare", message: `compare.${!lv.trim() ? "left" : "right"} resolved to empty — this verified nothing. A test that builds its own prompt is testing a program you do not ship.` }],
    };

  const outcome = runCompare(spec, lv, rv);
  if (outcome.ok)
    return {
      ok: true,
      failures: [],
      detail: { mode: outcome.mode, bytesIdentical: outcome.bytesIdentical, whitespaceOnly: outcome.whitespaceOnly },
    };
  return {
    ok: false,
    failures: [{ path: "compare", message: summarizeCompare(outcome) }],
    compareReport: formatCompareReport(outcome),
  };
}
