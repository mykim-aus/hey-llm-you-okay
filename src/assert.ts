/**
 * Expectation engine shared by all layers.
 *
 * A "value spec" is either a literal (deep-subset for objects, element-wise
 * for arrays, strict equality for primitives) or a matcher object using
 * $-prefixed keys — the $ prefix keeps literal payloads like {pattern: "x"}
 * unambiguous.
 *
 * Matchers: {$pattern,$flags} {$notPattern} {$eq} {$ne} {$in} {$gt/$gte/$lt/$lte}
 * {$exists} {$contains} {$notContains} {$length} {$minLength} {$maxLength}
 * {$type} {$any:[...]} {$all:[...]}
 */
import type { Failure } from "./types.js";
import { isPlainObject, deepGet, truncate } from "./util.js";

const isMatcher = (v: unknown): v is Record<string, unknown> =>
  isPlainObject(v) && Object.keys(v).some((k) => k.startsWith("$"));

function fail(failures: Failure[], path: string, message: string): void {
  failures.push({ path, message });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const isScalar = (v: unknown) => v !== null && v !== undefined && typeof v !== "object";

function containsValue(got: unknown, needle: unknown): boolean {
  // Scalars compare by string form on BOTH sides — YAML gives no way to say
  // "the number 23 as a string", so `$contains: 23` must behave the same
  // against "order 23" and against ["23"].
  if (typeof got === "string") return got.includes(String(needle));
  if (Array.isArray(got))
    return got.some(
      (v) =>
        deepEqual(v, needle) ||
        (isScalar(v) && isScalar(needle) && String(v) === String(needle)) ||
        (typeof v === "string" && typeof needle === "string" && v.includes(needle))
    );
  return false;
}

/** Match a value spec against got; append failures. */
export function matchValue(spec: unknown, got: unknown, path: string, failures: Failure[]): void {
  if (isMatcher(spec)) {
    for (const [key, arg] of Object.entries(spec)) {
      switch (key) {
        case "$pattern":
        case "$notPattern": {
          // A bad regex is an authoring error — say so, don't let it surface
          // later as a mysterious runtime/provider failure.
          let re: RegExp;
          try {
            re = new RegExp(String(arg), String(spec.$flags ?? ""));
          } catch (e: any) {
            fail(failures, path, `invalid ${key} regex /${arg}/: ${e.message} (JS has no inline (?i) — use $flags: "i")`);
            break;
          }
          const matched = re.test(String(got ?? ""));
          if (key === "$pattern" && !matched)
            fail(failures, path, `expected /${arg}/ to match, got: ${truncate(got, 200)}`);
          if (key === "$notPattern" && matched)
            fail(failures, path, `expected /${arg}/ NOT to match, got: ${truncate(got, 200)}`);
          break;
        }
        case "$flags":
          break; // consumed by $pattern/$notPattern
        case "$eq":
          if (!deepEqual(got, arg))
            fail(failures, path, `expected ${JSON.stringify(arg)}, got ${truncate(JSON.stringify(got), 200)}`);
          break;
        case "$ne":
          if (deepEqual(got, arg)) fail(failures, path, `expected != ${JSON.stringify(arg)}`);
          break;
        case "$in":
          if (!Array.isArray(arg) || !arg.some((v) => deepEqual(v, got)))
            fail(failures, path, `expected one of ${JSON.stringify(arg)}, got ${truncate(JSON.stringify(got), 120)}`);
          break;
        case "$gt":
          if (!(Number(got) > Number(arg))) fail(failures, path, `expected > ${arg}, got ${got}`);
          break;
        case "$gte":
          if (!(Number(got) >= Number(arg))) fail(failures, path, `expected >= ${arg}, got ${got}`);
          break;
        case "$lt":
          if (!(Number(got) < Number(arg))) fail(failures, path, `expected < ${arg}, got ${got}`);
          break;
        case "$lte":
          if (!(Number(got) <= Number(arg))) fail(failures, path, `expected <= ${arg}, got ${got}`);
          break;
        case "$exists": {
          const exists = got !== undefined && got !== null;
          if (exists !== !!arg)
            fail(failures, path, `expected exists=${arg}, got ${truncate(JSON.stringify(got), 80)}`);
          break;
        }
        case "$contains": {
          for (const n of Array.isArray(arg) ? arg : [arg])
            if (!containsValue(got, n))
              fail(failures, path, `expected to contain ${JSON.stringify(n)}, got: ${truncate(typeof got === "string" ? got : JSON.stringify(got), 200)}`);
          break;
        }
        case "$notContains": {
          for (const n of Array.isArray(arg) ? arg : [arg])
            if (containsValue(got, n)) fail(failures, path, `expected NOT to contain ${JSON.stringify(n)}`);
          break;
        }
        case "$length": {
          const len = (got as any)?.length;
          if (len !== arg) fail(failures, path, `expected length ${arg}, got ${len}`);
          break;
        }
        case "$minLength":
          if (!((got as any)?.length >= Number(arg)))
            fail(failures, path, `expected length >= ${arg}, got ${(got as any)?.length}`);
          break;
        case "$maxLength":
          if (!((got as any)?.length <= Number(arg)))
            fail(failures, path, `expected length <= ${arg}, got ${(got as any)?.length}`);
          break;
        case "$type": {
          const t = Array.isArray(got) ? "array" : got === null ? "null" : typeof got;
          if (t !== arg) fail(failures, path, `expected type ${arg}, got ${t}`);
          break;
        }
        case "$any": {
          const ok = (Array.isArray(arg) ? arg : []).some((s) => {
            const f: Failure[] = [];
            matchValue(s, got, path, f);
            return f.length === 0;
          });
          if (!ok)
            fail(failures, path, `no $any alternative matched (got: ${truncate(JSON.stringify(got), 160)})`);
          break;
        }
        case "$all":
          for (const s of Array.isArray(arg) ? arg : []) matchValue(s, got, path, failures);
          break;
        default:
          fail(failures, path, `unknown matcher ${key}`);
      }
    }
    return;
  }
  if (isPlainObject(spec)) {
    if (!isPlainObject(got)) {
      fail(failures, path, `expected object, got ${truncate(JSON.stringify(got), 120)}`);
      return;
    }
    for (const [k, v] of Object.entries(spec))
      matchValue(v, got[k], path ? `${path}.${k}` : k, failures);
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(got)) {
      fail(failures, path, `expected array, got ${truncate(JSON.stringify(got), 120)}`);
      return;
    }
    if (got.length !== spec.length) {
      fail(failures, path, `expected array length ${spec.length}, got ${got.length}`);
      return;
    }
    spec.forEach((v, i) => matchValue(v, got[i], `${path}[${i}]`, failures));
    return;
  }
  if (got !== spec)
    fail(failures, path, `expected ${JSON.stringify(spec)}, got ${truncate(JSON.stringify(got), 200)}`);
}

export interface GenericActual {
  status?: number;
  exitCode?: number | null;
  json?: unknown;
  text?: string;
  stdout?: string;
  stderr?: string;
  headers?: Record<string, string>;
}

/**
 * Apply a case-level `expect` block against a layer's actual shape.
 * Generic keys: status, exitCode, json, jsonPath, text, stdout, stderr, headers.
 * text/stdout/stderr accept a bare string as $contains shorthand.
 * Layer-specific keys (toolCalled and friends) must be consumed by the layer BEFORE
 * delegating here — unknown keys fail loudly (a typo must not silently pass).
 */
/** `{$exists: false}` is the one spec that may legitimately assert absence. */
const isExistsFalse = (spec: unknown) =>
  isPlainObject(spec) && Object.keys(spec).length === 1 && spec.$exists === false;

export function applyExpect(
  expect: Record<string, unknown> | undefined,
  actual: GenericActual,
  failures: Failure[]
): Failure[] {
  for (const [key, spec] of Object.entries(expect || {})) {
    switch (key) {
      case "status":
        matchValue(spec, actual.status, "status", failures);
        break;
      case "exitCode":
        matchValue(spec, actual.exitCode, "exitCode", failures);
        break;
      // json/jsonPath on a NON-JSON body must FAIL, never silently pass.
      // Otherwise a model that produced no structured output at all satisfies
      // every negative assertion ($ne/$notContains/$notPattern) — the worst
      // possible bug in a test framework.
      case "json":
        if (actual.json === undefined && !isExistsFalse(spec))
          failures.push({
            path: "json",
            message: `response body is not JSON, so 'json' cannot be evaluated: ${truncate(actual.text, 160)}`,
          });
        else matchValue(spec, actual.json, "json", failures);
        break;
      case "jsonPath":
        if (actual.json === undefined) {
          const allAbsence = Object.values((spec as Record<string, unknown>) || {}).every(isExistsFalse);
          if (!allAbsence) {
            failures.push({
              path: "jsonPath",
              message: `response body is not JSON, so 'jsonPath' cannot be evaluated: ${truncate(actual.text, 160)}`,
            });
            break;
          }
        }
        for (const [p, s] of Object.entries((spec as Record<string, unknown>) || {}))
          matchValue(s, deepGet(actual.json, p), `jsonPath.${p}`, failures);
        break;
      case "text":
      case "stdout":
      case "stderr": {
        const got = actual[key];
        const normalized = typeof spec === "string" ? { $contains: spec } : spec;
        matchValue(normalized, got, key, failures);
        break;
      }
      case "headers":
        for (const [h, s] of Object.entries((spec as Record<string, unknown>) || {}))
          matchValue(s, actual.headers?.[h.toLowerCase()], `headers.${h}`, failures);
        break;
      default:
        failures.push({ path: key, message: `unknown expect key '${key}' for this layer` });
    }
  }
  return failures;
}
