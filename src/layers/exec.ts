/**
 * exec layer — wrap ANY existing test runner (jest, vitest, playwright,
 * pytest, custom node harnesses…) as a pyramid stage. Fragmented legacy
 * suites become one pipeline without a rewrite.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { applyExpect } from "../assert.js";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";

const CAP = 64 * 1024; // keep the tail — failures print at the end of runner output

export async function runExecCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const cwd = cs.cwd ? path.resolve(ctx.baseDir, cs.cwd) : ctx.baseDir;
  const timeoutMs = cs.timeoutMs ?? 300000;

  const actual = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve) => {
    // detached → the child leads its own process group, so a timeout can kill
    // the WHOLE tree (`sh -c "npx jest"` spawns grandchildren that would
    // otherwise survive and hang the runner forever).
    const child = spawn("sh", ["-c", cs.command], {
      cwd,
      env: { ...process.env, ...(cs.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    // setEncoding: decode on the stream so multi-byte characters are never
    // split across chunk boundaries (Korean/Japanese output would corrupt).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTree = () => {
      try {
        process.kill(-(child.pid as number), "SIGKILL"); // negative pid = group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const cap = (s: string) => (s.length > CAP ? s.slice(-CAP) : s);
    child.stdout.on("data", (d: string) => (stdout = cap(stdout + d)));
    child.stderr.on("data", (d: string) => (stderr = cap(stderr + d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
  });

  if (actual.timedOut) failures.push({ path: "command", message: `timed out after ${timeoutMs}ms` });
  // keys that exist on other layers but never on a process result — reject
  // loudly (copying an http/llm case into exec must not silently always-pass)
  for (const key of ["status", "json", "jsonPath", "text", "headers"])
    if (cs.expect && key in cs.expect)
      failures.push({
        path: key,
        message: `'${key}' is not available on an exec case (did you mean 'stdout' or 'stderr'?)`,
      });
  const { status, json, jsonPath, text, headers, ...rest } = (cs.expect || {}) as Record<string, unknown>;
  applyExpect({ exitCode: 0, ...rest }, actual, failures);
  return {
    ok: !failures.length,
    failures,
    detail: { exitCode: actual.exitCode },
    outputTail: failures.length ? (actual.stderr || actual.stdout).slice(-4000) : undefined,
  };
}
