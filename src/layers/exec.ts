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
    const child = spawn("sh", ["-c", cs.command], {
      cwd,
      env: { ...process.env, ...(cs.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const cap = (s: string) => (s.length > CAP ? s.slice(-CAP) : s);
    child.stdout.on("data", (d) => (stdout = cap(stdout + d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr + d)));
    child.on("error", (e) =>
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, timedOut })
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
  });

  if (actual.timedOut) failures.push({ path: "command", message: `timed out after ${timeoutMs}ms` });
  applyExpect({ exitCode: 0, ...(cs.expect || {}) }, actual, failures);
  return {
    ok: !failures.length,
    failures,
    detail: { exitCode: actual.exitCode },
    outputTail: failures.length ? (actual.stderr || actual.stdout).slice(-4000) : undefined,
  };
}
