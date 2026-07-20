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
import { deepGet, interpolateDeep, resolveRef } from "../util.js";

const toArr = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v as string]);

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
  const system = (await resolveRef(interpolateDeep(cs.system, ctx.lookup), ctx.baseDir)) as string | undefined;
  let tools = (await resolveRef(cs.tools, ctx.baseDir)) as any;
  if (typeof tools === "string") tools = JSON.parse(tools);
  const toolResponses: Record<string, unknown> = {};
  for (const [name, fixture] of Object.entries(cs.toolResponses || {})) {
    let v = await resolveRef(fixture, ctx.baseDir);
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {} // plain-text tool responses are allowed
    }
    toolResponses[name] = v;
  }
  const base = { system, tools, toolResponses, params: cs.params || {} };
  if (cs.conversation) return { ...base, mode: "conversation", conversation: cs.conversation };
  if (cs.messages) return { ...base, mode: "messages", messages: normMessages(cs.messages) };
  return { ...base, mode: "prompt", prompt: interpolateDeep(cs.prompt, ctx.lookup) };
}

interface TurnOutcome {
  text: string;
  lastText: string;
  toolCalls: ToolCall[];
  finalMessages: ChatMessage[];
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
  const convo = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const res = await provider.chat({
      system: inputs.system,
      messages: convo,
      tools: inputs.tools,
      temperature: inputs.params.temperature,
      maxTokens: inputs.params.maxTokens,
      json: inputs.params.json,
    });
    text += (text && res.text ? " " : "") + (res.text || "");
    if (res.text) lastText = res.text;
    allCalls.push(...res.toolCalls);
    const answerable = res.toolCalls.filter((c) => inputs.toolResponses[c.name] !== undefined);
    if (!res.toolCalls.length || !answerable.length) break;
    convo.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    convo.push({
      role: "tool",
      toolResults: answerable.map((c) => ({ id: c.id, name: c.name, response: inputs.toolResponses[c.name] })),
    });
  }
  return { text, lastText, toolCalls: allCalls, finalMessages: convo };
}

export interface LlmActual {
  text: string;
  fullText: string;
  json: unknown;
  toolCalls: ToolCall[];
  toolNames: string[];
}

function buildActual(turn: TurnOutcome): LlmActual {
  const text = turn.lastText || turn.text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { text, fullText: turn.text, json, toolCalls: turn.toolCalls, toolNames: turn.toolCalls.map((c) => c.name) };
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
        for (const name of toArr(spec))
          if (!actual.toolNames.includes(name))
            failures.push({
              path: "toolCalled",
              message: `expected tool '${name}' to be called; called: ${JSON.stringify(actual.toolNames)}`,
            });
        break;
      case "anyToolCalled":
        if (!toArr(spec).some((n) => actual.toolNames.includes(n)))
          failures.push({
            path: "anyToolCalled",
            message: `expected one of ${JSON.stringify(toArr(spec))}; called: ${JSON.stringify(actual.toolNames)}`,
          });
        break;
      case "notToolCalled":
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
      messages = [...last.finalMessages, { role: "assistant", content: last.lastText || last.text }];
      if (turn.expect && perTurnFailures) {
        const fs: Failure[] = [];
        checkLlmExpect(turn.expect, buildActual(last), fs);
        for (const f of fs) perTurnFailures.push({ ...f, path: `turn[${i}].${f.path}` });
      }
    }
    const final = last as TurnOutcome;
    // conversation: final reply text, tool calls accumulated across ALL turns
    return { ...final, toolCalls: allCalls, transcript: messages };
  }
  const messages: ChatMessage[] =
    inputs.mode === "messages" ? [...(inputs.messages || [])] : [{ role: "user", content: inputs.prompt }];
  const res = await completeTurn(provider, inputs, messages, maxRounds);
  return { ...res, transcript: [...messages, { role: "assistant", content: res.lastText || res.text }] };
}

export async function runLlmCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const provider = ctx.providers[ctx.layer.provider as string];
  const inputs = await resolveLlmInputs(cs, ctx);
  const repeat = cs.repeat ?? ctx.layer.repeat ?? 1;
  const passRate = cs.passRate ?? ctx.layer.passRate ?? 1;
  const maxRounds = cs.maxRounds ?? 3;

  const attempts: AttemptResult[] = [];
  for (let i = 0; i < repeat; i++) {
    const failures: Failure[] = [];
    try {
      const out = await produceLlm(provider, inputs, { maxRounds, perTurnFailures: failures });
      const actual = buildActual(out);
      checkLlmExpect(cs.expect, actual, failures);
      attempts.push({ ok: !failures.length, failures, toolNames: actual.toolNames, text: actual.text });
    } catch (e: any) {
      attempts.push({ ok: false, failures: [{ path: "provider", message: e.message }] });
    }
  }
  const passed = attempts.filter((a) => a.ok).length;
  const ok = passed / attempts.length >= passRate;
  const failures: Failure[] = ok
    ? []
    : [
        ...(repeat > 1
          ? [{ path: "passRate", message: `passed ${passed}/${attempts.length} attempts (need ratio >= ${passRate})` }]
          : []),
        ...(attempts.find((a) => !a.ok)?.failures || []),
      ];
  return {
    ok,
    failures,
    detail: { attempts: attempts.length, passed, toolNames: attempts.at(-1)?.toolNames },
    resolvedInputs: inputs, // triage snapshots exactly what was sent
    attemptsDetail: attempts,
  };
}
