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
import { readFile } from "node:fs/promises";
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

type Reducer = (state: unknown, call: DispatchCall) => unknown | Promise<unknown>;

async function loadReducer(spec: DispatchSpec, baseDir: string): Promise<Reducer> {
  const file = path.resolve(baseDir, spec.module as string);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e: any) {
    // A `.js` file written as ESM inside a CommonJS package (no "type":
    // "module") — extremely common in Next.js/Babel projects, where the
    // bundler understands ESM but bare Node does not. A reducer is pure by
    // contract, so it is safe to evaluate as a standalone module.
    const cjsEsmClash =
      /Unexpected token 'export'|Cannot use import statement outside a module/.test(e?.message ?? "");
    if (cjsEsmClash) {
      try {
        const src = await readFile(file, "utf8");
        if (/^\s*(import|export)\s+[^(]/m.test(src.replace(/^\s*\/\/.*$/gm, ""))) {
          const relImport = src.match(/^\s*import[^;]*?from\s*["'](\.[^"']*)["']/m);
          if (relImport)
            throw new Error(
              `dispatch.module ${file} is ESM inside a CommonJS package AND imports '${relImport[1]}'.\n` +
                `  A reducer must be self-contained (no imports) so it can be evaluated standalone —\n` +
                `  inline what it needs, or rename the file to .mjs.`
            );
        }
        mod = (await import(
          `data:text/javascript;base64,${Buffer.from(src, "utf8").toString("base64")}`
        )) as Record<string, unknown>;
      } catch (inner: any) {
        throw new Error(
          `dispatch.module could not be imported: ${file}\n  ${inner.message || e.message}`
        );
      }
    } else {
      throw new Error(
        `dispatch.module could not be imported: ${file}\n  ${e.message}\n  (the reducer must be a plain ESM module — no bundler aliases, no JSX)`
      );
    }
  }
  const name = spec.export ?? "default";
  const fn = mod[name] ?? (mod as any).default;
  if (typeof fn !== "function")
    throw new Error(
      `dispatch.module ${file} has no callable export '${name}' (found: ${Object.keys(mod).join(", ") || "nothing"})`
    );
  return fn as Reducer;
}

/**
 * A subprocess reducer — the same contract, in any language.
 *
 * The JS `module:` path made this layer — heyllm's headline differentiator —
 * unusable on Python/Ruby/Go apps. We tried to use it on a large Python MCP
 * server and could not. This speaks one JSON request per line on stdin and
 * reads exactly one JSON response line from stdout:
 *
 *   → {"v":1,"index":0,"state":{...},"call":{"name":"open_ticket","args":{}}}
 *   ← {"state":{...},"effects":[{"type":"analytics"}]}
 *
 * `state` is sent on EVERY call, so the child stays a pure function of
 * (state, call) — the same promise the JS contract makes — and cannot leak
 * state between an llm case's repeated attempts.
 *
 * One process per call. Process reuse (and an fd-3 side channel) were designed
 * and cut: they need a line-splitter state machine, an outstanding-request
 * queue and premature-exit detection, for a round-trip cost that is microseconds
 * next to the interpreter start they were meant to amortise.
 *
 * STDOUT IS A DATA CHANNEL, NOT A LOG. Exactly one JSON line. The tempting
 * alternative — scan for the first parseable JSON and skip the junk — is
 * rejected outright: a stray `print({"status":"ok"})` would be eaten as a
 * response and the case would go green on fabricated state.
 */
async function spawnOnce(
  spec: DispatchSpec,
  baseDir: string,
  payload: unknown,
  probe = false
): Promise<{ line: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  const cwd = spec.cwd ? path.resolve(baseDir, spec.cwd) : baseDir;
  const cmd = spec.command as string;
  // resolved against the case file's dir when it looks like a path, else PATH
  const bin = /[\\/]/.test(cmd) ? path.resolve(cwd, cmd) : cmd;
  const timeoutMs = spec.timeoutMs ?? 30000;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, spec.args ?? [], {
        cwd,
        env: { ...process.env, ...(spec.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // kill the whole group on timeout — a reducer may spawn workers
      });
    } catch (e: any) {
      return reject(new Error(`could not spawn '${cmd}': ${e.message} (cwd: ${cwd})`));
    }
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
      reject(new Error(`reducer timed out after ${timeoutMs}ms${err.trim() ? ` — stderr: ${truncate(err.trim(), 300)}` : ""}`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out += d;
      if (out.length > 8 * 1024 * 1024) {
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {}
      }
    });
    child.stderr!.on("data", (d: string) => (err += d));
    child.stdin!.on("error", () => {});
    child.on("error", (e: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        new Error(
          e.code === "ENOENT"
            ? `could not spawn '${cmd}' (ENOENT) — not found on PATH or at ${bin} (cwd: ${cwd})`
            : `could not spawn '${cmd}': ${e.message}`
        )
      );
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (probe) return resolve({ line: "", stderr: err });
      if (code !== 0)
        return reject(new Error(`reducer exited ${code}${err.trim() ? ` — stderr: ${truncate(err.trim(), 300)}` : ""}`));
      const lines = out.split("\n").filter((l) => l.trim());
      if (lines.length !== 1)
        return reject(
          new Error(
            lines.length === 0
              ? `reducer produced no output — expected one JSON response line on stdout`
              : `expected one JSON response line on stdout, got ${lines.length} lines. stdout is the data channel — send diagnostics to stderr. First: \`${truncate(lines[0], 200)}\``
          )
        );
      resolve({ line: lines[0], stderr: err });
    });
    child.stdin!.write(JSON.stringify(payload) + "\n");
    child.stdin!.end();
  });
}

async function spawnReducer(spec: DispatchSpec, baseDir: string): Promise<Reducer> {
  // Eager liveness probe. Without it a broken `command:` is a SILENT NO-OP when
  // the model produces zero tool calls — the fold never runs, nothing spawns,
  // and the case passes having verified nothing. Fail here, at the same point
  // loadReducer would have failed.
  await spawnOnce({ ...spec, timeoutMs: Math.min(spec.timeoutMs ?? 30000, 10000) }, baseDir, { v: 1, probe: true }, true);

  let index = 0;
  return async (state: unknown, call: DispatchCall) => {
    const i = index++;
    const { line } = await spawnOnce(spec, baseDir, { v: 1, index: i, state, call });
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `call[${i}] ${call.name}: response is not JSON — stdout is the data channel, send diagnostics to stderr. Got: \`${truncate(line, 200)}\``
      );
    }
    if (!isPlainObject(parsed))
      throw new Error(`call[${i}] ${call.name}: response must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    // Precedence: `error` is checked FIRST and does not require `state` — a
    // reducer reporting "no handler for X" is exactly the signal this layer hunts.
    if (typeof parsed.error === "string" && parsed.error)
      throw new Error(`call[${i}] ${call.name}: reducer reported an error: ${parsed.error}`);
    if (!("state" in parsed))
      throw new Error(
        `call[${i}] ${call.name}: response envelope must have a 'state' key (got keys: ${Object.keys(parsed).join(", ") || "none"})`
      );
    if (parsed.effects !== undefined && !Array.isArray(parsed.effects))
      throw new Error(`call[${i}] ${call.name}: 'effects' must be an array, got ${typeof parsed.effects}`);
    return { state: parsed.state, effects: parsed.effects ?? [] };
  };
}

/** Load the JS module reducer or spawn the subprocess one — same shape out. */
async function makeReducer(spec: DispatchSpec, baseDir: string): Promise<Reducer> {
  return spec.command ? spawnReducer(spec, baseDir) : loadReducer(spec, baseDir);
}

/**
 * The two modes are mutually exclusive, and a key that belongs to the other mode
 * must be an error rather than silently ignored — an ignored key is the "case
 * asserts nothing and passes forever" shape this project already rejects.
 * Returns one message, or null. Shared by validateCases and the run path.
 */
export function checkDispatchMode(spec: Record<string, any>): string | null {
  if (spec.module && spec.command)
    return "has both 'module' and 'command' — a dispatch case is either a JS module or a subprocess, not both";
  // Exactly one problem, and the text keeps the literal `needs 'module'` the
  // existing config test matches on.
  if (!spec.module && !spec.command)
    return "needs 'module' (path to a JS reducer) or 'command' (a subprocess reducer in any language)";
  if (spec.command && spec.export) return "'export' applies to 'module' only, not 'command'";
  if (spec.module) {
    const strayKeys = (["args", "cwd", "env", "timeoutMs"] as const).filter((k) => spec[k] !== undefined);
    if (strayKeys.length)
      return `${strayKeys.join(", ")} appl${strayKeys.length > 1 ? "y" : "ies"} to 'command' only — with 'module' ${strayKeys.length > 1 ? "they are" : "it is"} silently ignored`;
  }
  if (spec.command && /\s/.test(spec.command) && !spec.args)
    return `command '${spec.command}' contains whitespace and is executed directly, NOT through a shell — put arguments in 'args:' instead`;
  return null;
}

/** Fold calls through the reducer, accumulating state and effects. */
export async function foldCalls(reduce: Reducer, initialState: unknown, calls: DispatchCall[]): Promise<DispatchOutcome> {
  let state = initialState;
  const effects: unknown[] = [];
  for (const call of calls) {
    // `await` on the sync JS reducer is a no-op, so that path is bit-identical.
    const out = await reduce(state, { name: call.name, args: call.args ?? {} });
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
    reduce = await makeReducer(spec, ctx.baseDir);
  } catch (e: any) {
    failures.push({ path: spec.command ? "dispatch.command" : "dispatch.module", message: e.message });
    return null;
  }
  try {
    const outcome = await foldCalls(
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
    command: cs.command,
    args: cs.args,
    cwd: cs.cwd,
    env: cs.env,
    timeoutMs: cs.timeoutMs,
    initialState: cs.initialState,
    expect: cs.expect,
  };
  // Mode checks run HERE too, not only in validateCases — `heyllm run` never
  // calls the validator, so a check that lives only there does nothing on the
  // ordinary run path.
  const modeProblem = checkDispatchMode(spec);
  if (modeProblem) return { ok: false, failures: [{ path: "module", message: modeProblem }] };
  let reduce: Reducer;
  try {
    reduce = await makeReducer(spec, ctx.baseDir);
  } catch (e: any) {
    return { ok: false, failures: [{ path: spec.command ? "command" : "module", message: e.message }] };
  }
  let outcome: DispatchOutcome;
  try {
    outcome = await foldCalls(reduce, structuredClone(spec.initialState ?? {}), calls);
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
