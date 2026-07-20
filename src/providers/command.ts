/**
 * Command provider — run ANY local CLI as a model or judge. This is how a
 * local Claude Code CLI (or any script) becomes a judge with zero API config:
 *
 *   kind: command
 *   command: claude
 *   args: ["-p", "--output-format", "json"]
 *   outputPath: result
 *
 * The normalized request is flattened to text and piped to stdin; stdout is
 * the reply. `outputPath` extracts a dotted path when stdout is JSON.
 * No tool-calling support (judges don't need it).
 */
import { spawn } from "node:child_process";
import type { ChatRequest, ChatResponse, ProviderConfig } from "../types.js";
import { deepGet, truncate } from "../util.js";

function buildPrompt(req: ChatRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(`[SYSTEM]\n${req.system}`);
  for (const m of req.messages || []) {
    if (m.role === "tool") continue;
    parts.push(`[${m.role.toUpperCase()}]\n${m.content ?? ""}`);
  }
  return parts.join("\n\n");
}

export function command(cfg: ProviderConfig) {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const prompt = buildPrompt(req);
      const stdout = await run(cfg.command as string, cfg.args || [], prompt, {
        timeoutMs: cfg.timeoutMs ?? 120000,
        env: cfg.env,
        cwd: cfg.cwd,
      });
      let text = stdout.trim();
      if (cfg.outputPath) {
        try {
          const v = deepGet(JSON.parse(text), cfg.outputPath);
          if (v !== undefined) text = typeof v === "string" ? v : JSON.stringify(v);
        } catch {
          /* raw text stays */
        }
      }
      return { text, toolCalls: [], raw: stdout };
    },
  };
}

function run(
  cmd: string,
  args: string[],
  stdin: string,
  { timeoutMs, env, cwd }: { timeoutMs: number; env?: Record<string, string>; cwd?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(env || {}) },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8"); // never split multi-byte chars on chunks
    child.stderr.setEncoding("utf8");
    let out = "";
    let errOut = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`command provider timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => (errOut += d));
    // a judge CLI that exits without draining stdin must not crash haechi
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`command provider failed to start '${cmd}': ${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`command provider '${cmd}' exited ${code}: ${truncate(errOut || out, 300)}`));
      resolve(out);
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
