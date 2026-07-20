/**
 * Shared utilities: colors, deep access, interpolation, file refs, mini-glob,
 * pooling, JSON fetch, LLM-JSON extraction. Zero deps beyond `yaml`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// ── colors ────────────────────────────────────────────────────────
const colorOn =
  !!process.env.FORCE_COLOR || (process.stdout.isTTY && !process.env.NO_COLOR);
const wrap =
  (a: number, b: number) =>
  (s: unknown): string =>
    colorOn ? `\x1b[${a}m${s}\x1b[${b}m` : String(s);
export const c = {
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
};

// ── data access ───────────────────────────────────────────────────
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** deepGet(obj, "a.b.0.c") — dotted-path lookup; empty path returns obj. */
export function deepGet(obj: unknown, dotted?: string | null): unknown {
  if (dotted == null || dotted === "") return obj;
  return String(dotted)
    .split(".")
    .reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── {{VAR}} interpolation ─────────────────────────────────────────
// Unknown names stay untouched — prompts may legitimately contain {{...}}.
export type Lookup = (name: string) => unknown;

export function interpolate(str: string, lookup: Lookup): string {
  return str.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (m, name: string) => {
    const v = lookup(name);
    return v === undefined ? m : String(v);
  });
}

export function interpolateDeep<T>(val: T, lookup: Lookup): T {
  if (typeof val === "string") return interpolate(val, lookup) as unknown as T;
  if (Array.isArray(val)) return val.map((v) => interpolateDeep(v, lookup)) as unknown as T;
  if (isPlainObject(val)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) out[k] = interpolateDeep(v, lookup);
    return out as T;
  }
  return val;
}

/**
 * Layered lookup; later scopes win. There is deliberately NO process.env
 * fallback: a blanket fallback silently expands `{{PATH}}`/`{{USER}}` inside
 * prompt bodies and can persist a real API key into the committed
 * `.heyllm/baseline.json` snapshot. Environment values reach templates only
 * through a layer's declared `env:` allowlist, which the runner passes in as
 * the base scope.
 */
export function makeLookup(...scopes: Array<Record<string, unknown> | undefined>): Lookup {
  return (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i];
      if (s && Object.prototype.hasOwnProperty.call(s, name)) return s[name];
    }
    return undefined;
  };
}

// ── file: / exec: refs ────────────────────────────────────────────
/**
 * Resolve reference strings against baseDir; non-refs pass through unchanged.
 *
 *   file:relative/path   read the file, resolved against the CASE FILE's dir
 *                        (.json files are parsed) — data lives next to cases
 *   exec:<command>       run the command (sh -c) and use stdout, with cwd =
 *                        the PROJECT ROOT (heyllm.yaml's dir), because an exec
 *                        ref is a project command: loaders, npm scripts and
 *                        .env all resolve from the root.
 *
 * `exec:` exists for prompts BUILT BY CODE rather than stored as files —
 * framework prompt builders, DB-assembled system prompts. Output is memoized
 * per process so repeat/votes/triage arms don't rebuild it, and triage
 * snapshots store the RESOLVED text, so exec-built prompts still get
 * snapshot-based A/B probing.
 */
const execRefCache = new Map<string, Promise<string>>();

function runExecRef(cmd: string, cwd: string): Promise<string> {
  // NUL joins the two halves because it is the one byte that cannot appear
  // in a path or a command, so no (cwd, cmd) pair can collide with another.
  // Written as an escape rather than a literal NUL: a raw control byte in the
  // source makes grep treat this whole file as binary and silently print
  // "Binary file matches" instead of the hits.
  const key = `${cwd}\u0000${cmd}`;
  let p = execRefCache.get(key);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(
          "sh",
          ["-c", cmd],
          { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120000 },
          (err, stdout, stderr) => {
            if (err)
              reject(
                new Error(`exec: ref failed (${cmd}): ${err.message}\n${truncate(stderr, 300)}`)
              );
            else resolve(stdout);
          }
        );
      });
    });
    execRefCache.set(key, p);
  }
  return p;
}

export async function resolveRef(
  value: unknown,
  baseDir: string,
  execCwd: string = baseDir,
  /** `compare:` wants the artifact's BYTES. Auto-parsing a .json file into an
   *  object makes the most natural comparison — a JSON snapshot pinned against
   *  a generator's stdout — impossible, since exec: always yields text. */
  opts: { raw?: boolean } = {}
): Promise<unknown> {
  if (typeof value !== "string") return value;
  if (value.startsWith("exec:")) {
    return (await runExecRef(value.slice(5).trim(), execCwd)).trim();
  }
  if (!value.startsWith("file:")) return value;
  const p = path.resolve(baseDir, value.slice(5));
  const text = await readFile(p, "utf8");
  if (!opts.raw && /\.json$/i.test(p)) {
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new Error(`invalid JSON in ${p}: ${e.message}`);
    }
  }
  return text;
}

// ── mini-glob (supports * and **) ────────────────────────────────
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const segRe = (seg: string) =>
  new RegExp("^" + seg.split("*").map(reEscape).join("[^/]*") + "$");

export async function glob(pattern: string, baseDir: string): Promise<string[]> {
  if (!pattern.includes("*")) {
    const p = path.resolve(baseDir, pattern);
    try {
      if ((await stat(p)).isFile()) return [p];
    } catch {}
    return [];
  }
  // Split into a literal prefix and the glob tail. The prefix is resolved with
  // path.resolve so `.`/`..` work (readdir never yields `..`, so those
  // segments could never be matched by the walker itself).
  const segs = pattern.split("/").filter(Boolean);
  const firstGlob = segs.findIndex((s) => s.includes("*"));
  const prefix = segs.slice(0, firstGlob);
  const tail = segs.slice(firstGlob);
  const start = pattern.startsWith("/")
    ? path.resolve("/", ...prefix)
    : path.resolve(baseDir, ...prefix);
  const out: string[] = [];
  await walk(start, tail, 0, out);
  out.sort();
  return out;
}

async function walk(dir: string, parts: string[], i: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const seg = parts[i];
  const last = i === parts.length - 1;
  if (seg === "**") {
    if (last) {
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile()) out.push(p);
        else if (e.isDirectory()) await walk(p, parts, i, out);
      }
      return;
    }
    await walk(dir, parts, i + 1, out); // ** matches zero dirs
    for (const e of entries)
      if (e.isDirectory()) await walk(path.join(dir, e.name), parts, i, out);
    return;
  }
  const re = segRe(seg);
  for (const e of entries) {
    if (!re.test(e.name)) continue;
    const p = path.join(dir, e.name);
    // Dirent.isFile()/isDirectory() are FALSE for symlinks — stat through them
    // so a symlinked prompt/test file behaves like the real thing (an exact
    // non-glob path already follows links via stat()).
    const [isFile, isDir] = e.isSymbolicLink()
      ? await stat(p).then(
          (s) => [s.isFile(), s.isDirectory()],
          () => [false, false] // broken link
        )
      : [e.isFile(), e.isDirectory()];
    if (last) {
      if (isFile) out.push(p);
    } else if (isDir) {
      await walk(p, parts, i + 1, out);
    }
  }
}

// ── misc ──────────────────────────────────────────────────────────
export function truncate(s: unknown, n = 400): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + `… (+${str.length - n} chars)` : str;
}

export function ms(d: number): string {
  return d >= 1000 ? (d / 1000).toFixed(1) + "s" : Math.round(d) + "ms";
}

export function xmlEscape(s: unknown): string {
  return String(s).replace(
    /[<>&"']/g,
    (ch) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] as string
  );
}

export const sleep = (msec: number) => new Promise((r) => setTimeout(r, msec));

/** Run fn over items with at most n concurrent workers; preserves order. */
export async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const ret = new Array<R>(items.length);
  let i = 0;
  const size = Math.max(1, Math.min(n || 1, items.length));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      ret[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

/** POST JSON with timeout + retry on 429/5xx/network errors. */
export async function postJson(
  url: string,
  {
    headers = {},
    body,
    timeoutMs = 60000,
    retries = 1,
  }: { headers?: Record<string, string>; body: unknown; timeoutMs?: number; retries?: number }
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        const hint =
          res.status === 401 || res.status === 403
            ? " — check the API key this provider reads from apiKeyEnv"
            : res.status === 404
              ? " — check `model` and `baseUrl`"
              : "";
        const err: any = new ProviderError(
          `HTTP ${res.status} from ${url}${hint}: ${truncate(text, 300)}`
        );
        err.status = res.status;
        throw err;
      }
      return json ?? {};
    } catch (err: any) {
      const retriable =
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.cause?.code === "ECONNRESET" ||
        err.cause?.code === "ECONNREFUSED";
      if (attempt < retries && retriable) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      // An HTTP-status failure already carries its own explanation; only the
      // opaque transport errors need translating.
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(describeFetchFailure(err, url));
    }
  }
}

/**
 * Turn Node's famously unhelpful "fetch failed" into something actionable.
 *
 * `fetch` collapses connection-refused, DNS failure and TLS errors into one
 * bare string with no URL attached, which is how a missing local model server
 * ends up looking like a mysterious test failure. The cause lives on
 * `err.cause`, so we name the host and say what to check.
 */
function describeFetchFailure(err: any, url: string): string {
  const cause = err?.cause ?? err;
  const code = cause?.code ?? err?.code;
  let host = url;
  try {
    host = new URL(url).origin;
  } catch {}

  if (err?.name === "TimeoutError" || err?.name === "AbortError")
    return `no response from ${host} within the timeout`;
  if (code === "ECONNREFUSED")
    return `cannot connect to ${host} (connection refused) — is the server running? A local provider (Ollama, LM Studio, vLLM) has to be started separately.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return `cannot resolve the host for ${host} (${code}) — check the baseUrl.`;
  if (code === "CERT_HAS_EXPIRED" || String(code).startsWith("ERR_TLS"))
    return `TLS failure talking to ${host} (${code})`;
  const detail = cause?.message && cause.message !== err?.message ? `: ${cause.message}` : "";
  return `request to ${host} failed (${err?.message ?? String(err)})${detail}`;
}

/**
 * Minimal .env loader (no dependency). Existing process.env values WIN — CI
 * secrets must never be shadowed by a stale local .env. Supports KEY=value,
 * `export KEY=value`, # comments, and single/double quoted values.
 */
export async function loadEnvFile(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = v;
      loaded.push(m[1]);
    }
  }
  return loaded;
}

/**
 * Names that came from `settings.envFile` — NOT from the ambient shell.
 *
 * WHY THIS IS TRACKED SEPARATELY (measured in a real project, 2026-07-20):
 * `settings.envFile: .env` loads API keys so `heyllm run` works without manual
 * exports. But `exec` cases spawn children with the runner's whole environment,
 * so those keys reached the child too — and a Jest suite whose live tests
 * self-skip via `if (process.env.GEMINI_API_KEY)` suddenly stopped skipping.
 * Every pre-deploy run silently made paid API calls that the author had
 * deliberately gated off. The env file is heyllm's own config, not the child's:
 * an exec child inherits these ONLY when its layer or case names them in `env`.
 * Same principle as `{{VAR}}` interpolation, which also expands declared vars only.
 */
export const envFileVars = new Set<string>();

/** Extract the first balanced JSON object from LLM text (code fences tolerated). */
export function extractJson(text: unknown): any | null {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── provider failures ─────────────────────────────────────────────
/**
 * Thrown when a provider could not be reached, authenticated, or understood.
 *
 * The distinction this carries is the whole point: a wrong answer is a test
 * result, but an unreachable provider means the model never answered at all.
 * Reporting the second as a soft, non-gated case failure is how a suite ends
 * up printing PASS while nothing was actually verified — so this is tagged at
 * the provider call boundary and surfaced by the runner no matter how the
 * layer is gated.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerName?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Run a provider call, tagging anything it throws as an infrastructure fault. */
export async function callProvider<T>(providerName: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(e?.message ?? String(e), providerName);
  }
}
