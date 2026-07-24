/**
 * exec layer — wrap ANY existing test runner (jest, vitest, playwright,
 * pytest, custom node harnesses…) as a pyramid stage. Fragmented legacy
 * suites become one pipeline without a rewrite.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { applyExpect } from "../assert.js";
import { caseKey } from "../baseline.js";
import { fingerprintExec, isCacheStale, normalizeIgnore } from "../changed.js";
import { envFileVars } from "../util.js";
import type { CaseCtx, CaseDef, CaseResult, Failure } from "../types.js";

const CAP = 64 * 1024; // keep the tail — failures print at the end of runner output

/**
 * Exit code an exec case uses to say "I could not measure" — rate limited, the
 * service was down, the dev server was restarting. Reported as INFRA (exit 2),
 * never as a failing test: a rate-limited harness that reports "0/12 passed"
 * is indistinguishable from a real regression, and that is how a green suite
 * starts lying in the other direction too. Same reasoning as an unreachable
 * provider — "we never got to ask" is not "your prompt broke".
 */
export const INFRA_EXIT = 97;

/**
 * The child gets the ambient shell environment, but NOT the vars heyllm itself
 * loaded from `settings.envFile`, unless this layer/case names them in `env`.
 * See the comment on envFileVars: silently handing API keys to a wrapped test
 * runner un-skips its opt-in live tests and bills the user for it.
 */
function childEnv(cs: CaseDef, ctx: CaseCtx): NodeJS.ProcessEnv {
  const declared = new Set<string>([...(ctx.layer.env || []), ...Object.keys(cs.env || {})]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!envFileVars.has(k) || declared.has(k)) out[k] = v;
  return { ...out, ...(cs.env || {}) };
}

interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    // detached → the child leads its own process group, so a timeout can kill
    // the WHOLE tree (`sh -c "npx jest"` spawns grandchildren that would
    // otherwise survive and hang the runner forever).
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
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
}

export async function runExecCase(cs: CaseDef, ctx: CaseCtx): Promise<CaseResult> {
  const failures: Failure[] = [];
  const cwd = cs.cwd ? path.resolve(ctx.baseDir, cs.cwd) : ctx.baseDir;
  const timeoutMs = cs.timeoutMs ?? 300000;

  // ── `fingerprint:` — a cheap probe command whose output stands in for the
  // payload fingerprint (see fingerprintExec for the full rationale). Probed
  // only under --changed-only: on a normal run the probe would be pure
  // overhead, and record-on-pass still happens on the first changed-only run.
  let promptFingerprint: { key: string; fp: string } | undefined;
  let changedNote: string | undefined;
  if (cs.fingerprint && ctx.changedOnly) {
    const probe = await runShell(String(cs.fingerprint), cwd, childEnv(cs, ctx), timeoutMs);
    if (probe.exitCode === 0 && !probe.timedOut) {
      const ignore = normalizeIgnore(cs.fingerprintIgnore ?? (ctx.layer as any).fingerprintIgnore);
      const key = caseKey(ctx.layer.name, cs.name);
      promptFingerprint = { key, fp: fingerprintExec(cs.command, probe.stdout, ignore) };
      if (!ctx.alwaysRun) {
        const prev = ctx.promptStore?.cases[key];
        const maxAgeDays =
          cs.maxCacheAgeDays ?? ctx.layer.maxCacheAgeDays ?? ctx.config.settings.changedOnly?.maxCacheAgeDays;
        const stale = prev && isCacheStale(prev.at, maxAgeDays, ctx.nowMs ?? Date.now());
        if (prev && prev.fp === promptFingerprint.fp && stale) {
          changedNote = `fingerprint unchanged but cache older than ${maxAgeDays}d (last passed ${prev.at}) — re-running live to catch drift`;
        } else if (prev && prev.fp === promptFingerprint.fp) {
          // A wrapped runner's output cannot be replayed the way a cached LLM
          // reply can — skip outright. The stored record only ever comes from a
          // PASSING run (record-on-pass), so "unchanged" always means "unchanged
          // since it was last green".
          return {
            ok: true,
            failures: [],
            skipped: `unchanged — fingerprint identical since ${prev.at}`,
            promptFingerprint,
          };
        }
      }
    } else {
      // Fail OPEN — run the real command — but say so. No fingerprint is
      // recorded, so the case keeps re-running until the probe is fixed: a
      // broken probe degrades to "always run" (safe), never to "always skip".
      changedNote = `fingerprint probe failed (${probe.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${probe.exitCode}`}) — ran the case anyway; fix the probe to regain --changed-only skips`;
    }
  }

  const actual = await runShell(cs.command, cwd, childEnv(cs, ctx), timeoutMs);

  if (actual.exitCode === INFRA_EXIT)
    return {
      ok: false,
      failures: [
        {
          path: "command",
          message: `could not measure (exit ${INFRA_EXIT}): ${(actual.stderr || actual.stdout).trim().slice(-300) || "no output"}`,
          infra: true,
        },
      ],
      detail: { exitCode: actual.exitCode },
      outputTail: (actual.stderr || actual.stdout).slice(-4000),
    };
  if (actual.timedOut) failures.push({ path: "command", message: `timed out after ${timeoutMs}ms` });
  // `parseStdout: true` — the command emits JSON on stdout (e.g. a Playwright /
  // Puppeteer check printing the UI state it observed: {"panelVisible": true}).
  // This makes browser/DOM assertions first-class WITHOUT heyllm shipping a
  // browser dependency: your script drives the page, prints what it saw, and the
  // exec case asserts it with json/jsonPath — the same matchers as every layer.
  const wantsJson = !!cs.parseStdout;
  const PARSE_FAIL = Symbol("parse-fail");
  let parsed: unknown = undefined;
  if (wantsJson) {
    try {
      parsed = JSON.parse((actual.stdout || "").trim());
    } catch {
      parsed = PARSE_FAIL;
    }
    if (parsed === PARSE_FAIL)
      failures.push({ path: "stdout", message: "parseStdout: true but stdout was not valid JSON" });
  }
  // keys that exist on other layers but never on a process result — reject
  // loudly (copying an http/llm case into exec must not silently always-pass).
  // json/jsonPath are allowed ONLY under parseStdout.
  const forbidden = wantsJson ? ["status", "text", "headers"] : ["status", "json", "jsonPath", "text", "headers"];
  for (const key of forbidden)
    if (cs.expect && key in cs.expect)
      failures.push({
        path: key,
        message: `'${key}' is not available on an exec case${wantsJson ? "" : " (did you mean 'stdout' or 'stderr'? add parseStdout: true to assert JSON printed on stdout)"}`,
      });
  const clean: Record<string, unknown> = { ...(cs.expect || {}) };
  for (const k of forbidden) delete clean[k];
  applyExpect(
    { exitCode: 0, ...clean },
    { ...actual, ...(wantsJson && parsed !== PARSE_FAIL ? { json: parsed } : {}) },
    failures
  );
  return {
    ok: !failures.length,
    failures,
    detail: { exitCode: actual.exitCode },
    outputTail: failures.length ? (actual.stderr || actual.stdout).slice(-4000) : undefined,
    // emitted on failure too — the runner records it only on pass, but triage
    // reads it either way to say whether the case's inputs moved
    ...(promptFingerprint ? { promptFingerprint } : {}),
    ...(changedNote ? { changedNote } : {}),
  };
}
