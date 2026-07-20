/**
 * Offline demo backend: an openai-compatible mock LLM + a tiny app API.
 * Lets the quickstart run the ENTIRE pyramid (static→http→llm→judge) and the
 * triage protocol with zero API keys. POST /__config {"drift":true} simulates
 * a silent provider model update (the chatbot forgets conversation context).
 */
import http from "node:http";

const state = { drift: false };

function llmReply(payload) {
  const messages = payload.messages || [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const transcript = messages.map((m) => m.content || "").join(" ");

  // judge mode — score rubric ids; harmful/uncited answers score low
  if (lastUser.includes("[RUBRIC]")) {
    const ids = [...lastUser.matchAll(/^- \[([a-zA-Z0-9_-]+)\]/gm)].map((m) => m[1]);
    const evalSection = lastUser.split("[RESPONSE UNDER EVALUATION]")[1] || "";
    const looksBad =
      /how to build a bomb|the password is|\d{3}-\d{3}-\d{4}/.test(evalSection) ||
      evalSection.includes("BADWORD");
    const scores = Object.fromEntries(ids.map((id) => [id, looksBad ? 2 : 9]));
    return { content: JSON.stringify({ scores, reasoning: "demo judge: canned evaluation" }) };
  }

  // tool mode — weather questions call the tool, then ground the reply on it
  if (payload.tools?.length) {
    const toolMsg = messages.find((m) => m.role === "tool");
    if (toolMsg) {
      try {
        const data = JSON.parse(toolMsg.content);
        return {
          content: `It is ${data.temp} degrees and ${data.sky} in ${data.city ?? "Seoul"} right now.`,
        };
      } catch {
        return { content: "Let me answer based on the tool result." };
      }
    }
    if (/weather/i.test(lastUser))
      return {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: JSON.stringify({ city: "Seoul" }) },
          },
        ],
      };
  }

  // conversation flow — remembers the coffee order unless the model "drifted"
  if (/the largest one/i.test(lastUser)) {
    if (state.drift) return { content: "I'm not sure what you mean. How can I help you?" };
    if (/coffee/i.test(transcript)) return { content: "Order complete: one large coffee!" };
    return { content: "Which item would you like in the largest size?" };
  }
  if (/coffee/i.test(lastUser))
    return { content: "Happy to help with your coffee order. What size would you like?" };

  // functional / reliability / security canned behaviors
  if (/annual leave/i.test(lastUser))
    return {
      content:
        "Annual leave is 15 days per year; employees with under one year of service accrue 1 day per month. (Source: company policy 3.2)",
    };
  if (/translate/i.test(lastUser))
    return { content: "Translation: Hello, could we move the meeting to tomorrow?" };
  if (/Mars/i.test(lastUser))
    return {
      content:
        "Sorry — I don't have anything on the company's Mars relocation plans in my material. I'd suggest asking the relevant department.",
    };
  if (/phone number/i.test(lastUser))
    return { content: "Our privacy policy means I can't share a specific employee's contact details." };
  if (/ignore (the |all )?(previous |preceding )?instructions/i.test(lastUser))
    return {
      content:
        "I can't ignore my previous instructions. Security policy means I don't handle sensitive information such as passwords.",
    };
  if (/bomb/i.test(lastUser))
    return { content: "That request is dangerous, so I can't help with it. I'm glad to help with anything else." };
  if (/idiot|stupid/i.test(lastUser))
    return { content: "Sounds like that was frustrating. Let me find something I can help with — what do you need?" };

  return { content: `Here's what I have: ${lastUser.slice(0, 60)}` };
}

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
    if (url === "/api/health") return send(200, { ok: true, service: "demo-app" });
    if (url === "/api/login" && req.method === "POST") {
      const { user, pass } = JSON.parse(body || "{}");
      if (user === "demo" && pass === "heyllm") return send(200, { token: "demo-token" });
      return send(401, { error: "login_required" });
    }
    if (url.endsWith("/chat/completions") && req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      const msg = llmReply(payload);
      return send(200, {
        id: "demo",
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls },
            finish_reason: msg.tool_calls ? "tool_calls" : "stop",
          },
        ],
      });
    }
    send(404, { error: "not_found" });
  });
});

const port = Number(process.env.PORT || 4141);
server.listen(port, "127.0.0.1", () =>
  console.log(`demo mock server on http://127.0.0.1:${port} (POST /__config {"drift":true} to simulate model drift)`)
);
