/**
 * static layer — the cheapest gate. No network, no LLM. Typo/forbidden
 * patterns, required patterns, JSON/YAML validity, existence, size.
 * Belongs first in the pyramid: milliseconds, deterministic, free.
 */
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";
import { glob, truncate } from "../util.js";

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
