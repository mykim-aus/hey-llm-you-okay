/**
 * llm layer — real model calls with DETERMINISTIC assertions: which tools were
 * called, which uiAction/JSON fields came back, which patterns the text must
 * (not) contain. This is the "[prompt → model decision]" joint of the dispatch
 * chain, isolated from everything the app does afterwards.
 *
 * Input modes (pick one):
 *   prompt: "single user message"
 *   messages: [{user}, {assistant}, ...]              # scripted history, 1 completion
 *   conversation: [{user, expect?}, ...]              # live multi-turn
 * Tool loop:
 *   tools: file:fixtures/tools.json | [inline]
 *   toolResponses: { toolName: file:...|{inline} }    # feed back, continue the turn
 * Flaky control: repeat + passRate (sampling is noise, not signal).
 */
import { applyExpect, matchValue } from "../assert.js";
import type {
  AttemptResult,
  CaseCtx,
  CaseDef,
  CaseResult,
  ChatMessage,
  Failure,
  Provider,
  ResolvedLlmInputs,
  ToolCall,
} from "../types.js";
import { ProviderError, callProvider, deepGet, interpolateDeep, resolveRef } from "../util.js";
import { checkInputContract } from "../inputs.js";
import { runDispatchBlock } from "./dispatch.js";
import { caseKey } from "../baseline.js";
import { changedRunReason, fingerprintLlm, isCacheStale, normalizeIgnore, unchangedSkipReason } from "../changed.js";

const toArr = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v as string]);

/**
 * `toolCalled` compares tool NAMES, so it takes a string or a list of strings —
 * not a matcher object. Writing `toolCalled: { $in: [a, b] }` used to stringify
 * to `[object Object]` and report that a tool by that literal name was never
 * called, which reads as a model failure instead of a malformed expectation.
 * The layer already fails loudly on an unknown expect KEY; this extends the
 * same promise to a wrong VALUE, and names the key that does what was meant.
 */
function assertToolNameSpec(key: string, spec: unknown, failures: Failure[]): boolean {
  const bad = toArr(spec).filter((n) => typeof n !== "string");
  if (!bad.length) return true;
  const hint =
    key === "toolCalled"
      ? " — for 'one of these', use `anyToolCalled: [a, b]`"
      : " — pass a tool name or a list of names";
  failures.push({
    path: key,
    message:
      `'${key}' takes a tool name or a list of tool names, got ${JSON.stringify(spec)}${hint}`,
  });
  return false;
}

function normMessages(list: any[]): ChatMessage[] {
  return (list || []).map((m) => {
    if (m.user !== undefined) return { role: "user" as const, content: m.user };
    if (m.assistant !== undefined) return { role: "assistant" as const, content: m.assistant };
    return { role: m.role, content: m.content };
  });
}

/**
 * Resolve file: refs & interpolation → the EXACT inputs sent to the model.
 * This object is what the triage engine snapshots: the artifact under test.
 */
export async function resolveLlmInputs(cs: Record<string, any>, ctx: CaseCtx): Promise<ResolvedLlmInputs> {
  const root = ctx.config.baseDir; // exec: refs are project commands → run from the root
  const systemRef = interpolateDeep(cs.system, ctx.lookup);
  const system = (await resolveRef(systemRef, ctx.baseDir, root)) as string | undefined;
  let tools = (await resolveRef(cs.tools, ctx.baseDir, root)) as any;
  if (typeof tools === "string") tools = JSON.parse(tools);
  const toolResponses: Record<string, unknown> = {};
  for (const [name, fixture] of Object.entries(cs.toolResponses || {})) {
    let v = await resolveRef(fixture, ctx.baseDir, root);
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {} // plain-text tool responses are allowed
    }
    toolResponses[name] = v;
  }
  const base = {
    system,
    tools,
    toolResponses,
    params: cs.params || {},
    systemRef,
    providerName: (ctx.layer.provider ?? ctx.layer.subject) as string | undefined,
  };
  if (cs.conversation) return { ...base, mode: "conversation", conversation: cs.conversation };
  if (cs.messages) return { ...base, mode: "messages", messages: normMessages(cs.messages) };
  return { ...base, mode: "prompt", prompt: interpolateDeep(cs.prompt, ctx.lookup) };
}

interface TurnOutcome {
  text: string;
  lastText: string;
  toolCalls: ToolCall[];
  finalMessages: ChatMessage[];
  /** tools the model called that had no fixture — the turn could not continue */
  unanswered: string[];
}

/** One completion incl. tool-fixture feedback rounds. */
async function completeTurn(
  provider: Provider,
  inputs: ResolvedLlmInputs,
  messages: ChatMessage[],
  maxRounds: number
): Promise<TurnOutcome> {
  const allCalls: ToolCall[] = [];
  let text = "";
  let lastText = "";
  let unanswered: string[] = [];
  const convo = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const res = await callProvider(inputs.providerName, () =>
      provider.chat({
        system: inputs.system,
        messages: convo,
        tools: inputs.tools,
        temperature: inputs.params.temperature,
        maxTokens: inputs.params.maxTokens,
        json: inputs.params.json,
      })
    );
    text += (text && res.text ? " " : "") + (res.text || "");
    if (res.text) lastText = res.text;
    allCalls.push(...res.toolCalls);
    if (!res.toolCalls.length) {
      unanswered = [];
      break;
    }
    // EVERY tool call must be answered — a partial tool_results block is a
    // protocol violation on all three APIs. `toolResponseDefault` lets the
    // turn continue past tools the case doesn't care about.
    const fallback = inputs.params.toolResponseDefault;
    const missing = res.toolCalls.filter((c) => inputs.toolResponses[c.name] === undefined);
    if (missing.length && fallback === undefined) {
      unanswered = [...new Set(missing.map((c) => c.name))];
      break; // model is waiting for a response we cannot give
    }
    unanswered = [];
    convo.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    convo.push({
      role: "tool",
      toolResults: res.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        response: inputs.toolResponses[c.name] ?? fallback,
      })),
    });
  }
  return { text, lastText, toolCalls: allCalls, finalMessages: convo, unanswered };
}

export interface LlmActual {
  text: string;
  fullText: string;
  json: unknown;
  toolCalls: ToolCall[];
  toolNames: string[];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildActual(turn: TurnOutcome): LlmActual {
  const text = turn.lastText || turn.text;
  return { text, fullText: turn.text, json: safeJson(text), toolCalls: turn.toolCalls, toolNames: turn.toolCalls.map((c) => c.name) };
}

/** llm-specific expect keys first, then generic assert.js keys. */
export function checkLlmExpect(
  expect: Record<string, unknown> | undefined,
  actual: LlmActual,
  failures: Failure[]
): void {
  const rest: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(expect || {})) {
    switch (key) {
      case "toolCalled":
        if (!assertToolNameSpec("toolCalled", spec, failures)) break;
        for (const name of toArr(spec))
          if (!actual.toolNames.includes(name))
            failures.push({
              path: "toolCalled",
              message: `expected tool '${name}' to be called; called: ${JSON.stringify(actual.toolNames)}`,
            });
        break;
      case "anyToolCalled": {
        // Two forms:
        //   anyToolCalled: [a, b]                    — at least one was called
        //   anyToolCalled: { names: [a, b], args: {} } — ...and THAT call's args match
        // The second form exists because equivalent tools are a real pattern:
        // when two tools produce the same user-visible outcome, the test should
        // assert the outcome (grounded by case number) rather than force one
        // arbitrary branch.
        const isObj = !Array.isArray(spec) && typeof spec === "object" && spec !== null;
        const names = toArr(isObj ? (spec as any).names : spec);
        const hit = actual.toolCalls.filter((c) => names.includes(c.name));
        if (!hit.length) {
          failures.push({
            path: "anyToolCalled",
            message: `expected one of ${JSON.stringify(names)}; called: ${JSON.stringify(actual.toolNames)}`,
          });
          break;
        }
        const argSpec = isObj ? (spec as any).args : undefined;
        if (argSpec !== undefined) {
          // pass if ANY matching call satisfies the args
          const ok = hit.some((c) => {
            const f: Failure[] = [];
            matchValue(argSpec, c.args, "args", f);
            return f.length === 0;
          });
          if (!ok) {
            const f: Failure[] = [];
            matchValue(argSpec, hit[0].args, `anyToolCalled(${hit[0].name}).args`, f);
            failures.push(...f);
          }
        }
        break;
      }
      case "notToolCalled":
        if (!assertToolNameSpec("notToolCalled", spec, failures)) break;
        for (const name of toArr(spec))
          if (actual.toolNames.includes(name))
            failures.push({
              path: "notToolCalled",
              message: `tool '${name}' must NOT be called; called: ${JSON.stringify(actual.toolNames)}`,
            });
        break;
      case "toolArgs":
        for (const [toolName, pathSpecs] of Object.entries((spec as Record<string, any>) || {})) {
          const call = actual.toolCalls.find((c) => c.name === toolName);
          if (!call) {
            failures.push({ path: `toolArgs.${toolName}`, message: `tool was not called` });
            continue;
          }
          for (const [p, s] of Object.entries(pathSpecs || {}))
            matchValue(s, deepGet(call.args, p), `toolArgs.${toolName}.${p}`, failures);
        }
        break;
      // keys that exist on other layers but never on an llm response — reject
      // loudly instead of silently comparing against undefined
      case "status":
      case "exitCode":
      case "headers":
      case "stdout":
      case "stderr":
        failures.push({
          path: key,
          message: `'${key}' is not available on an llm case (did you mean 'text' or 'jsonPath'?)`,
        });
        break;
      default:
        rest[key] = spec;
    }
  }
  applyExpect(rest, { text: actual.text, json: actual.json }, failures);
}

export interface ProduceResult extends TurnOutcome {
  transcript: ChatMessage[];
}

/** Execute a case once from resolved inputs against a provider. */
export async function produceLlm(
  provider: Provider,
  inputs: ResolvedLlmInputs,
  { maxRounds = 3, perTurnFailures }: { maxRounds?: number; perTurnFailures?: Failure[] } = {}
): Promise<ProduceResult> {
  if (inputs.mode === "conversation") {
    let messages: ChatMessage[] = [];
    let last: TurnOutcome | null = null;
    const allCalls: ToolCall[] = [];
    for (const [i, turn] of (inputs.conversation || []).entries()) {
      messages.push({ role: "user", content: turn.user });
      last = await completeTurn(provider, inputs, messages, maxRounds);
      allCalls.push(...last.toolCalls);
      // An EMPTY assistant message is a 400 on Anthropic (only the final
      // message may be blank), so never push one. It happens when the model
      // replied with tool calls only and we had no fixture to continue with.
      const reply = last.lastText || last.text;
      messages = reply ? [...last.finalMessages, { role: "assistant", content: reply }] : [...last.finalMessages];
      if (!reply && last.unanswered.length) {
        perTurnFailures?.push({
          path: `turn[${i}].toolResponses`,
          message: `model called ${last.unanswered.map((t) => `'${t}'`).join(", ")} with no fixture, so the conversation cannot continue (add toolResponses or params.toolResponseDefault)`,
        });
        break;
      }
      if (turn.expect && perTurnFailures) {
        const fs: Failure[] = [];
        checkLlmExpect(turn.expect, buildActual(last), fs);
        for (const f of fs) perTurnFailures.push({ ...f, path: `turn[${i}].${f.path}` });
      }
    }
    const final = last as TurnOutcome;
    // conversation: final reply text, tool calls accumulated across ALL turns
    return { ...final, toolCalls: allCalls, transcript: messages };
    // (unanswered carries through from the final turn)
  }
  const messages: ChatMessage[] =
    inputs.mode === "messages" ? [...(inputs.messages || [])] : [{ role: "user", content: inputs.prompt }];
  const res = await completeTurn(provider, inputs, messages, maxRounds);
  return { ...res, transcript: [...messages, { role: "assistant", content: res.lastText || res.text }] };
}

export async function runLlmCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const provider = ctx.providers[ctx.layer.provider as string];
  // Resolution runs OUTSIDE the per-attempt try/catch, so a prompt-builder that
  // exits non-zero or a moved prompt file would land in the generic runner
  // bucket with no path. Attribute it to the ref that actually broke.
  let inputs: ResolvedLlmInputs;
  try {
    inputs = await resolveLlmInputs(cs, ctx);
  } catch (e: any) {
    return { ok: false, failures: [{ path: "inputs", message: `could not resolve case inputs: ${e.message}` }] };
  }
  // Before any paid call: is the case sending what this layer's contract claims,
  // and did a declared system ref actually resolve to something? A miss here is
  // a hard failure that costs zero tokens.
  const contract = checkInputContract(cs, inputs, ctx.layer);
  if (contract.length) return { ok: false, failures: contract };

  // --changed-only: if the EXACT payload (system + turns + tools + params +
  // model) is byte-identical to this case's last run, skip before any paid call.
  // The fingerprint is emitted regardless so a normal run refreshes the store.
  const model = ctx.providers[ctx.layer.provider as string]?.model;
  const ignore = normalizeIgnore(cs.fingerprintIgnore ?? (ctx.layer as any).fingerprintIgnore);
  const fp = fingerprintLlm(inputs, model, ignore);
  const key = caseKey(ctx.layer.name, cs.name);
  const promptFingerprint = { key, fp };
  let changedNote: string | undefined;
  if (ctx.changedOnly && !ctx.alwaysRun) {
    const prev = ctx.promptStore?.cases[key];
    const maxAgeDays = cs.maxCacheAgeDays ?? ctx.layer.maxCacheAgeDays ?? ctx.config.settings.changedOnly?.maxCacheAgeDays;
    const stale = prev && isCacheStale(prev.at, maxAgeDays, ctx.nowMs ?? Date.now());
    if (prev && prev.fp === fp && stale) {
      // Input unchanged, but the cache is older than maxCacheAgeDays — the
      // provider may have drifted since. Fall through to a real model call to
      // re-verify, and say why (this is the periodic drift check).
      changedNote = `cache older than ${maxAgeDays}d (last verified ${prev.at}) — re-running against the live model to catch provider drift`;
    } else if (prev && prev.fp === fp) {
      // Input unchanged and fresh. Rather than skip (and report nothing), REPLAY the
      // cached model output through the assertions — a real verdict at zero
      // API cost. This also re-checks a changed `expect:` (which is not part of
      // the fingerprint) against the same output for free. Only when the output
      // was cached and there is no dispatch fold to reproduce; otherwise skip.
      if (prev.output && !cs.dispatch) {
        const cachedActual: LlmActual = {
          text: prev.output.text,
          fullText: prev.output.fullText,
          json: safeJson(prev.output.text),
          toolCalls: prev.output.toolCalls,
          toolNames: prev.output.toolCalls.map((c) => c.name),
        };
        const failures: Failure[] = [];
        checkLlmExpect(cs.expect, cachedActual, failures);
        return {
          ok: !failures.length,
          failures,
          cached: `input unchanged since ${prev.at} — replayed the cached output (no model call)`,
          detail: { attempts: 0, cached: true, toolNames: cachedActual.toolNames },
          resolvedInputs: inputs,
          // do NOT re-emit promptFingerprint: a cached replay must not overwrite
          // the stored output (it would re-timestamp without a fresh run).
        };
      }
      return { ok: true, failures: [], skipped: `unchanged — payload identical since ${prev.at}`, promptFingerprint, resolvedInputs: inputs };
    }
    // Not skipped: if a baseline existed and the payload differs, say why — a
    // case that re-runs every time is a non-deterministic payload defeating the
    // saving, and the user cannot see that without being told. (Skipped when a
    // stale-cache note was already set above.)
    if (!changedNote) changedNote = changedRunReason(ctx.promptStore, key, fp) ?? undefined;
  }

  const repeat = cs.repeat ?? ctx.layer.repeat ?? 1;
  const passRate = cs.passRate ?? ctx.layer.passRate ?? 1;
  const maxRounds = cs.maxRounds ?? 3;

  const attempts: AttemptResult[] = [];
  let dispatchState: unknown;
  let dispatchEffects: unknown[] | undefined;
  // The output cached for a --changed-only replay must be a PASSING attempt's
  // output — under passRate < 1 the case can pass while its LAST attempt failed,
  // and caching that last attempt would make the replay disagree with the live
  // verdict. Prefer the first clean attempt; fall back to the last only if none
  // passed (in which case the case fails and nothing gets cached anyway).
  let passingActual: LlmActual | undefined;
  let lastActual: LlmActual | undefined;
  for (let i = 0; i < repeat; i++) {
    const failures: Failure[] = [];
    try {
      const out = await produceLlm(provider, inputs, { maxRounds, perTurnFailures: failures });
      const actual = buildActual(out);
      lastActual = actual;
      checkLlmExpect(cs.expect, actual, failures);
      if (!failures.length && !passingActual) passingActual = actual;
      // the chain does not end at the model: fold its calls through the app's
      // reducer and assert the state the user would actually have seen
      if (cs.dispatch) {
        const outcome = await runDispatchBlock(cs.dispatch, actual.toolCalls, ctx, failures);
        if (outcome) {
          dispatchState = outcome.state;
          dispatchEffects = outcome.effects;
        }
      }
      attempts.push({ ok: !failures.length, failures, toolNames: actual.toolNames, text: actual.text });
    } catch (e: any) {
      const infra = e instanceof ProviderError;
      attempts.push({
        ok: false,
        failures: [{ path: infra ? "provider" : "runner", message: e.message, infra }],
      });
    }
  }
  const passed = attempts.filter((a) => a.ok).length;
  // An attempt that never reached the model produced NO verdict, so it must not
  // be laundered through passRate as an ordinary miss. With repeat: 4 and
  // passRate: 0.25, three unreachable attempts and one success used to report a
  // clean PASS — a green run for a case measured once out of four times.
  const infraAttempts = attempts.filter((a) => (a.failures || []).some((f) => f.infra));
  const ok = passed / attempts.length >= passRate && infraAttempts.length === 0;
  const failures: Failure[] = [];
  if (infraAttempts.length)
    failures.push({
      path: "provider",
      message:
        `${infraAttempts.length} of ${attempts.length} attempt(s) never reached the provider, so this case has no verdict: ` +
        (infraAttempts[0].failures || []).map((f) => f.message).join("; "),
      infra: true,
    });
  if (!ok && passed / attempts.length < passRate) {
    if (repeat > 1)
      failures.push({
        path: "passRate",
        message: `passed ${passed}/${attempts.length} attempts (need ratio >= ${passRate})`,
      });
    failures.push(...(attempts.find((a) => !a.ok && !(a.failures || []).some((f) => f.infra))?.failures || []));
  }
  // Cache a PASSING attempt's output for a future --changed-only replay — only
  // for a dispatch-free case (a fold cannot be reproduced from text) and only
  // when the case passed (record-on-pass mirrors the fingerprint policy). Using
  // the passing attempt, not the last, keeps the replay verdict equal to live.
  const toCache = passingActual ?? lastActual;
  const cacheable = ok && !cs.dispatch && toCache;
  return {
    ok,
    failures,
    ...(changedNote ? { changedNote } : {}),
    detail: { attempts: attempts.length, passed, toolNames: attempts.at(-1)?.toolNames },
    ...(cs.dispatch ? { dispatchState, dispatchEffects } : {}),
    resolvedInputs: inputs, // triage snapshots exactly what was sent
    attemptsDetail: attempts,
    promptFingerprint: cacheable
      ? { ...promptFingerprint, output: { text: toCache!.text, fullText: toCache!.fullText, toolCalls: toCache!.toolCalls } }
      : promptFingerprint,
  };
}
