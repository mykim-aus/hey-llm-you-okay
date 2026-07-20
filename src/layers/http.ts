/**
 * http layer — real endpoint integration (auth errors, quotas, DB-backed
 * routes). Cases in one file run sequentially so `save:` can chain values
 * (login → token → authorized call) via {{token}}.
 */
import { applyExpect } from "../assert.js";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";
import { deepGet, interpolateDeep } from "../util.js";

export async function runHttpCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const req = interpolateDeep(cs.request || {}, ctx.lookup);
  const { method = "GET", url, headers = {}, json, body, timeoutMs = 15000 } = req;
  if (!url) return { ok: false, failures: [{ path: "request.url", message: "required" }] };

  let actual: { status: number; json: unknown; text: string; headers: Record<string, string> };
  try {
    const init: RequestInit = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      const h = init.headers as Record<string, string>;
      if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type"))
        h["content-type"] = "application/json";
    } else if (body !== undefined) {
      init.body = String(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {}
    actual = {
      status: res.status,
      json: parsed,
      text,
      headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
    };
  } catch (e: any) {
    return { ok: false, failures: [{ path: "request", message: `${method} ${url} failed: ${e.message}` }] };
  }

  applyExpect(cs.expect || {}, actual, failures);
  if (cs.save)
    for (const [name, pathSpec] of Object.entries(cs.save as Record<string, string>))
      ctx.saved[name] = deepGet(actual, pathSpec);
  return { ok: !failures.length, failures, detail: { status: actual.status } };
}
