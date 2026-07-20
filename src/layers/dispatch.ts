/**
 * dispatch layer — verify what your APP does with a model response.
 *
 * Every other LLM testing tool stops at "did the model say the right thing".
 * Real bugs live one step later: the model calls the right tool, and the UI
 * still doesn't change — because the handler is missing, the branch is gated
 * on stale state, or the enum drifted from the switch. This layer closes that
 * gap by folding tool calls / actions through YOUR reducer and asserting the
 * resulting state.
 *
 * Your module exports a reducer:
 *
 *   export function reduce(state, call) {
 *     if (call.name === "show_case_explanation") {
 *       if (state.screenState === "hidden") return state;          // gate
 *       return { state: { ...state, panel: { kind: "case", n: call.args.caseNumber } },
 *                effects: [{ type: "trackCaseView" }] };
 *     }
 *     return state;
 *   }
 *
 * Return either the next state, or `{ state, effects }`. Effects accumulate
 * across calls so you can assert side-effects (analytics, navigation, IO)
 * without executing them.
 *
 * Two ways to drive it:
 *   kind: dispatch  — replay RECORDED calls, no model, free and gated
 *   llm case + `dispatch:` block — fold the LIVE model's calls, full chain
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyExpect, matchValue } from "../assert.js";
import type { CaseCtx, CaseDef, CaseResult, DispatchSpec, Failure, ToolCall } from "../types.js";
import { isPlainObject, truncate } from "../util.js";

export interface DispatchCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface DispatchOutcome {
  state: unknown;
  effects: unknown[];
}

type Reducer = (state: unknown, call: DispatchCall) => unknown;

async function loadReducer(spec: DispatchSpec, baseDir: string): Promise<Reducer> {
  const file = path.resolve(baseDir, spec.module);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e: any) {
    throw new Error(
      `dispatch.module could not be imported: ${file}\n  ${e.message}\n  (the reducer must be a plain ESM module — no bundler aliases, no JSX)`
    );
  }
  const name = spec.export ?? "default";
  const fn = mod[name] ?? (mod as any).default;
  if (typeof fn !== "function")
    throw new Error(
      `dispatch.module ${file} has no callable export '${name}' (found: ${Object.keys(mod).join(", ") || "nothing"})`
    );
  return fn as Reducer;
}

/** Fold calls through the reducer, accumulating state and effects. */
export function foldCalls(reduce: Reducer, initialState: unknown, calls: DispatchCall[]): DispatchOutcome {
  let state = initialState;
  const effects: unknown[] = [];
  for (const call of calls) {
    const out = reduce(state, { name: call.name, args: call.args ?? {} });
    if (isPlainObject(out) && ("state" in out || "effects" in out)) {
      if ("state" in out) state = out.state;
      const e = (out as any).effects;
      if (Array.isArray(e)) effects.push(...e);
      else if (e !== undefined) effects.push(e);
    } else {
      state = out;
    }
  }
  return { state, effects };
}

/** Assert a dispatch outcome against `expect: { state?, effects? }`. */
export function checkDispatchExpect(
  expect: Record<string, unknown> | undefined,
  outcome: DispatchOutcome,
  failures: Failure[],
  pathPrefix = "dispatch"
): void {
  const rest: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(expect || {})) {
    if (key === "state") matchValue(spec, outcome.state, `${pathPrefix}.state`, failures);
    else if (key === "effects") matchValue(spec, outcome.effects, `${pathPrefix}.effects`, failures);
    else rest[key] = spec;
  }
  if (Object.keys(rest).length)
    applyExpect(rest, { json: outcome.state, text: JSON.stringify(outcome.state) }, failures);
}

/** Run a `dispatch:` block against tool calls the model actually produced. */
export async function runDispatchBlock(
  spec: DispatchSpec,
  toolCalls: ToolCall[],
  ctx: CaseCtx,
  failures: Failure[]
): Promise<DispatchOutcome | null> {
  let reduce: Reducer;
  try {
    reduce = await loadReducer(spec, ctx.baseDir);
  } catch (e: any) {
    failures.push({ path: "dispatch.module", message: e.message });
    return null;
  }
  try {
    const outcome = foldCalls(
      reduce,
      structuredClone(spec.initialState ?? {}),
      toolCalls.map((c) => ({ name: c.name, args: c.args }))
    );
    checkDispatchExpect(spec.expect, outcome, failures);
    return outcome;
  } catch (e: any) {
    failures.push({ path: "dispatch", message: `reducer threw: ${e.message}` });
    return null;
  }
}

/**
 * `kind: dispatch` case — replay recorded calls with NO model involved.
 * This is the cheap gated layer that catches a missing handler or a broken
 * gate condition on every commit, for free.
 */
export async function runDispatchCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const calls: DispatchCall[] = cs.calls || [];
  if (!Array.isArray(calls) || !calls.length)
    return { ok: false, failures: [{ path: "calls", message: "needs a non-empty 'calls' array" }] };
  for (const c of calls)
    if (!c?.name)
      return { ok: false, failures: [{ path: "calls", message: `every call needs a 'name': ${truncate(JSON.stringify(c), 80)}` }] };

  const spec: DispatchSpec = {
    module: cs.module,
    export: cs.export,
    initialState: cs.initialState,
    expect: cs.expect,
  };
  let reduce: Reducer;
  try {
    reduce = await loadReducer(spec, ctx.baseDir);
  } catch (e: any) {
    return { ok: false, failures: [{ path: "module", message: e.message }] };
  }
  let outcome: DispatchOutcome;
  try {
    outcome = foldCalls(reduce, structuredClone(spec.initialState ?? {}), calls);
  } catch (e: any) {
    return { ok: false, failures: [{ path: "reducer", message: `reducer threw: ${e.message}` }] };
  }
  checkDispatchExpect(cs.expect, outcome, failures, "expect");
  return {
    ok: !failures.length,
    failures,
    dispatchState: outcome.state,
    dispatchEffects: outcome.effects,
    detail: { calls: calls.length, effects: outcome.effects.length },
  };
}
