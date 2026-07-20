/**
 * Deterministic mock LLM server (openai-compatible /chat/completions).
 * Behavior is driven by request content so tests stay reproducible:
 *
 *   [RUBRIC] in last user msg      → judge mode: ids containing "strict" score 3,
 *                                    others 9; if the evaluated response contains
 *                                    BADWORD every id scores 3.
 *   tools present + "날씨" in msg   → tool_call get_weather({city:"서울"});
 *                                    after a tool result → "서울은 맑음입니다"
 *   "FLAKY" in last user msg       → 1st call per unique prompt fails ("NOPE"),
 *                                    later calls pass ("MAGIC")
 *   system contains SAY: <word>    → replies exactly <word>
 *   drift mode ON (POST /__config) → replies "DRIFTED" (simulated provider update)
 *   otherwise                      → "echo: <last user msg>"
 *
 * Also serves a tiny app API for http-layer tests:
 *   GET  /api/health → 200 {ok:true}
 *   POST /api/login  → {user,pass} → 200 {token} | 401 {error:"login_required"}
 *   GET  /api/me     → Authorization: Bearer <token> → 200 {email} | 401
 */
import http from "node:http";

export function startMockLLM() {
  const state = { drift: false, counters: new Map(), requests: [] };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = req.url || "";

      if (url === "/__config" && req.method === "POST") {
        Object.assign(state, JSON.parse(body || "{}"));
        return send(200, { ok: true, drift: state.drift });
      }
      if (url === "/api/health") return send(200, { ok: true });
      if (url === "/api/login" && req.method === "POST") {
        const { user, pass } = JSON.parse(body || "{}");
        if (user === "haechi" && pass === "beast") return send(200, { token: "tok-123" });
        return send(401, { error: "login_required" });
      }
      if (url === "/api/me") {
        if (req.headers.authorization === "Bearer tok-123")
          return send(200, { email: "haechi@example.com" });
        return send(401, { error: "unauthorized" });
      }

      if (url.endsWith("/chat/completions") && req.method === "POST") {
        const payload = JSON.parse(body || "{}");
        state.requests.push(payload);
        const messages = payload.messages || [];
        const sys = messages.find((m) => m.role === "system")?.content || "";
        const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
        const reply = (content, toolCalls) =>
          send(200, {
            id: "mock",
            model: payload.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: content ?? null, tool_calls: toolCalls },
                finish_reason: toolCalls ? "tool_calls" : "stop",
              },
            ],
          });

        // judge mode
        if (lastUser.includes("[RUBRIC]")) {
          const ids = [...lastUser.matchAll(/^- \[([a-zA-Z0-9_-]+)\]/gm)].map((m) => m[1]);
          const evalSection = lastUser.split("[RESPONSE UNDER EVALUATION]")[1] || "";
          const bad = evalSection.includes("BADWORD");
          const scores = Object.fromEntries(
            ids.map((id) => [id, bad ? 3 : id.includes("strict") ? 3 : 9])
          );
          return reply(JSON.stringify({ scores, reasoning: "mock judge reasoning" }));
        }

        // tool mode
        if (payload.tools?.length) {
          const sawToolResult = messages.some((m) => m.role === "tool");
          if (sawToolResult) return reply("서울은 맑음입니다");
          if (lastUser.includes("날씨"))
            return reply(null, [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: JSON.stringify({ city: "서울" }) },
              },
            ]);
        }

        if (state.drift) return reply("DRIFTED");

        if (lastUser.includes("FLAKY")) {
          const n = (state.counters.get(lastUser) || 0) + 1;
          state.counters.set(lastUser, n);
          return reply(n === 1 ? "NOPE" : "MAGIC");
        }

        const m = sys.match(/SAY:\s*(\S+)/);
        return reply(m ? m[1] : `echo: ${lastUser}`);
      }

      send(404, { error: "not_found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        state,
        setDrift: async (on) => {
          await fetch(`${base}/__config`, { method: "POST", body: JSON.stringify({ drift: on }) });
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
