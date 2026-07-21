/**
 * scenario layer — multi-turn integration against a REAL endpoint.
 *
 * `http` sends ONE request. But conversational bugs live across turns: state that
 * only goes wrong on turn 3, a closing line that contradicts turn 1, a UI that
 * drifts from the reply a turn later. A scenario drives N user turns through a
 * conversational route, THREADS the accumulated history back into each request,
 * and asserts what the endpoint returned after each turn — the real backend, the
 * real prompt, the real post-processing, across the whole exchange.
 *
 *   kind: scenario
 *   cases:
 *     - name: study-flow
 *       request: { url: "{{BASE}}/api/talk", headers: { Cookie: "s={{TOKEN}}" } }
 *       body: { locale: ko, mode: study, study: { caseId: 2, stage: concept } }
 *       userField: message            # where the turn's text goes (default "message")
 *       historyField: history         # request field the running history is sent as (null to omit)
 *       historyContentKey: text       # key each history item uses for its text (default "content")
 *       replyPath: data.answer        # where the assistant's text is in the response, for history
 *       turns:
 *         - { user: "Case 2 학습 시작", expect: { status: 200, json: { data: { type: study } } } }
 *         - { user: "이해했어요",       expect: { json: { data: { stageAction: advance } } } }
 */
import { applyExpect } from "../assert.js";
import type { CaseCtx, CaseDef, CaseResult, ChatMessage, Failure } from "../types.js";
import { deepGet, interpolateDeep, makeLookup, type Lookup } from "../util.js";

interface ScenarioTurn {
  user: string;
  expect?: Record<string, unknown>;
  save?: Record<string, string>;
}

export interface DriveResult {
  /** the conversation as user/assistant messages — for a downstream judge */
  transcript: ChatMessage[];
  failures: Failure[];
  turns: number;
}

/**
 * Drive a conversational endpoint over N turns, threading the running history
 * back into each request. Shared by `scenario` (deterministic per-turn asserts)
 * and `conversation` (judge the resulting transcript). A turn with no `expect`
 * still asserts `status < 400` by default — a 4xx/5xx is a failure unless the
 * turn explicitly expects it, so a scenario can never pass while the endpoint errors.
 */
export async function driveConversation(cs: CaseDef, ctx: CaseCtx): Promise<DriveResult> {
  const failures: Failure[] = [];
  const turns: ScenarioTurn[] = Array.isArray(cs.turns) ? cs.turns : [];
  const transcript: ChatMessage[] = [];
  if (!turns.length) {
    failures.push({ path: "turns", message: "needs a non-empty 'turns' array" });
    return { transcript, failures, turns: 0 };
  }
  const req = cs.request || {};
  if (!req.url) {
    failures.push({ path: "request.url", message: "required" });
    return { transcript, failures, turns: 0 };
  }
  const method = req.method || "POST";
  const userField: string = cs.userField || "message";
  const historyField: string | null = cs.historyField === null ? null : cs.historyField || "history";
  const contentKey: string = cs.historyContentKey || "content";
  const timeoutMs: number = req.timeoutMs || 20000;
  const saved: Record<string, unknown> = { ...ctx.saved };

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const local = makeLookup(saved, { user: turn.user });
    const lookup: Lookup = (name) => {
      const v = local(name);
      return v !== undefined ? v : ctx.lookup(name);
    };
    const url = interpolateDeep(req.url, lookup) as string;
    const headers = interpolateDeep(req.headers || {}, lookup) as Record<string, string>;
    const body: Record<string, unknown> = { ...(interpolateDeep(cs.body || {}, lookup) as Record<string, unknown>), [userField]: turn.user };
    // send the running history in the request's history field (mapped to contentKey)
    if (historyField)
      body[historyField] = transcript.map((m) => ({ role: m.role, [contentKey]: m.content }));

    let actual: { status: number; json: unknown; text: string; headers: Record<string, string> };
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      actual = { status: res.status, json, text, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])) };
    } catch (e: any) {
      failures.push({ path: `turn[${i}].request`, message: `${method} ${url} failed: ${e.message}` });
      break;
    }

    if (turn.expect) {
      const fs: Failure[] = [];
      applyExpect(turn.expect, actual, fs);
      for (const f of fs) failures.push({ ...f, path: `turn[${i}].${f.path}` });
    } else if (actual.status >= 400) {
      // no explicit assertion — a request that errors is still a failure, never a
      // silent green. Assert a real status the endpoint didn't error on.
      failures.push({ path: `turn[${i}].status`, message: `HTTP ${actual.status} with no expect on this turn — a 4xx/5xx is a failure unless the turn expects it` });
    }
    if (turn.save) for (const [k, p] of Object.entries(turn.save)) saved[k] = deepGet(actual, p);

    transcript.push({ role: "user", content: turn.user });
    const reply = cs.replyPath ? deepGet(actual.json, cs.replyPath) : actual.json;
    transcript.push({ role: "assistant", content: typeof reply === "string" ? reply : JSON.stringify(reply ?? actual.text) });
  }
  return { transcript, failures, turns: turns.length };
}

export async function runScenarioCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const { failures, turns } = await driveConversation(cs, ctx);
  return { ok: !failures.length, failures, detail: { turns } };
}
