/**
 * `compare:` — assert that two artifacts are the same thing.
 *
 * The case study's headline bug: a test helper rebuilt the system prompt,
 * production assembled it elsewhere, nobody compared them, and 7 whole sections
 * (4,445 chars) were missing while every test stayed green. The stated fix is
 * "extract the assembly into one function both call" — but nothing in the tool
 * could ASSERT the equivalence, so every user had to hand-roll an exec script.
 * This is that assertion.
 *
 * Pure module: no fs, no async, no imports from assert.ts. The static layer
 * resolves the two refs and hands us the strings; everything here is a testable
 * function over text. Scope is deliberately the honest 80% — strict equality
 * with a report a human can act on. Rejected in review and left for later:
 * `subset:`, `ignore:` blanking, json/yaml structural modes, intra-line
 * windowing. Each of those had a silent-green failure mode; a compare that
 * passes for the wrong reason is the exact bug this feature exists to catch.
 */

export type CompareMode = "exact" | "normalized";
export const COMPARE_MODES: CompareMode[] = ["exact", "normalized"];

export interface CompareSpec {
  left: string;
  right: string;
  mode: CompareMode;
  /** regex with exactly one capture group naming a section; markdown auto-detected if omitted */
  sections?: string;
}

export interface Section {
  name: string;
  body: string;
  line: number;
}

export interface SectionDetect {
  source: "configured" | "auto" | "none";
  pattern: string | null;
  sections: Section[];
}

export interface CompareOutcome {
  ok: boolean;
  mode: CompareMode;
  bytesIdentical: boolean;
  whitespaceOnly: boolean;
  sizes: { left: number; right: number; leftLines: number; rightLines: number };
  labels: { left: string; right: string };
  detect: { left: SectionDetect; right: SectionDetect };
  sectionDiff: { onlyLeft: Section[]; onlyRight: Section[]; differing: { name: string; left: Section; right: Section }[] };
  firstDivergence: { byte: number; leftLine: number; rightLine: number; leftText: string; rightText: string } | null;
}

// A ref (`file:../x.txt` / `exec:node build.js`) shortened for use as a label.
function labelOf(ref: string): string {
  const body = ref.startsWith("file:") ? ref.slice(5) : ref.startsWith("exec:") ? ref.slice(5) : ref;
  const base = ref.startsWith("file:") ? body.split("/").pop() || body : body;
  return base.length > 24 ? base.slice(0, 23) + "…" : base;
}

/**
 * Validate a raw `compare:` mapping. Returns the normalized spec, or a list of
 * problem strings. Called from BOTH config validation and the runtime path —
 * `heyllm run` never calls the validator, so any check that lives only in
 * config.ts silently does nothing on the ordinary run path. Everything a
 * malformed spec must be rejected for has to be here.
 */
export function normalizeCompareSpec(raw: unknown, at: string): CompareSpec | string[] {
  const problems: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return [`${at}: 'compare' must be a mapping with 'left' and 'right'`];
  const r = raw as Record<string, unknown>;

  const KNOWN = new Set(["left", "right", "mode", "sections"]);
  for (const k of Object.keys(r))
    if (!KNOWN.has(k))
      problems.push(`${at}: unknown compare key '${k}' (known: ${[...KNOWN].join(", ")})`);

  for (const side of ["left", "right"] as const) {
    const v = r[side];
    if (typeof v !== "string" || !v)
      problems.push(`${at}: compare.${side} is required and must be a string ref`);
    else if (!v.startsWith("file:") && !v.startsWith("exec:"))
      // A bare path is passed through by resolveRef unchanged, so `left: prompts/x`
      // would compare the literal 9-char string — a silent false green.
      problems.push(`${at}: compare.${side} must be a file: or exec: ref (got '${v.slice(0, 30)}')`);
  }

  let mode: CompareMode = "normalized";
  if (r.mode !== undefined) {
    if (typeof r.mode !== "string" || !COMPARE_MODES.includes(r.mode as CompareMode))
      problems.push(`${at}: compare.mode '${r.mode}' is not valid — expected one of: ${COMPARE_MODES.join(", ")}`);
    else mode = r.mode as CompareMode;
  }

  if (r.sections !== undefined) {
    if (typeof r.sections !== "string") problems.push(`${at}: compare.sections must be a regex string`);
    else {
      try {
        const re = new RegExp(r.sections);
        // one capture group names the section; the count is derivable by running
        // it against a sentinel and reading the length of the match array minus 1.
        const groups = new RegExp(r.sections + "|").exec("")!.length - 1;
        if (groups !== 1)
          problems.push(`${at}: compare.sections must have exactly one capture group (has ${groups})`);
        void re;
      } catch (e: any) {
        problems.push(`${at}: compare.sections is not a valid regex: ${e.message}`);
      }
    }
  }

  if (problems.length) return problems;
  return { left: r.left as string, right: r.right as string, mode, ...(r.sections ? { sections: r.sections as string } : {}) };
}

const MD_SECTION = /^#{1,6}\s+(.+?)\s*$/;

/**
 * Split text into named sections. Only markdown headers are auto-detected —
 * the review cut the XML/bracket/ALLCAPS candidates because they match content
 * as readily as structure (a prompt full of `# example` lines), inflating the
 * count. A ≥1-heading result wins; below that it is "none" and the caller falls
 * back to whole-document comparison. An explicit `sections:` regex overrides.
 */
export function detectSections(text: string, pattern?: string): SectionDetect {
  const re = pattern ? new RegExp(pattern) : MD_SECTION;
  const lines = text.split("\n");
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && m[1] !== undefined) {
      if (cur) sections.push(cur);
      cur = { name: m[1].trim(), body: "", line: i + 1 };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + lines[i];
    }
  }
  if (cur) sections.push(cur);
  const source: SectionDetect["source"] = pattern ? "configured" : sections.length ? "auto" : "none";
  return { source, pattern: pattern ?? (sections.length ? MD_SECTION.source : null), sections };
}

// normalized mode: CRLF->LF, strip trailing per-line whitespace, collapse >=2
// blank lines to one, trim the document. Interior spaces and leading indent are
// left alone — in a prompt they are semantic (list depth, code alignment).
function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstDivergenceOf(a: string, b: string): CompareOutcome["firstDivergence"] {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;
  const lineAt = (s: string, idx: number) => s.slice(0, idx).split("\n").length;
  const lineText = (s: string, idx: number) => {
    const start = s.lastIndexOf("\n", idx - 1) + 1;
    const end = s.indexOf("\n", idx);
    return s.slice(start, end === -1 ? undefined : end);
  };
  return {
    byte: i,
    leftLine: lineAt(a, i),
    rightLine: lineAt(b, i),
    leftText: lineText(a, i),
    rightText: lineText(b, i),
  };
}

export function runCompare(spec: CompareSpec, leftRaw: string, rightRaw: string): CompareOutcome {
  const bytesIdentical = leftRaw === rightRaw;
  const left = spec.mode === "normalized" ? normalizeText(leftRaw) : leftRaw;
  const right = spec.mode === "normalized" ? normalizeText(rightRaw) : rightRaw;
  const equal = left === right;
  // Whitespace-only means: the strings differ, but only in whitespace. True when
  // a normalized pass hid raw differences, OR when an exact FAILURE would have
  // passed under normalize — the latter is the signal to suggest mode:normalized.
  const whitespaceOnly = !bytesIdentical && normalizeText(leftRaw) === normalizeText(rightRaw);

  const dl = detectSections(leftRaw, spec.sections);
  const dr = detectSections(rightRaw, spec.sections);
  const byName = (arr: Section[]) => new Map(arr.map((s) => [s.name, s]));
  const lm = byName(dl.sections);
  const rm = byName(dr.sections);
  const onlyLeft = dl.sections.filter((s) => !rm.has(s.name));
  const onlyRight = dr.sections.filter((s) => !lm.has(s.name));
  const differing: CompareOutcome["sectionDiff"]["differing"] = [];
  for (const s of dl.sections) {
    const other = rm.get(s.name);
    if (other && normalizeText(s.body) !== normalizeText(other.body))
      differing.push({ name: s.name, left: s, right: other });
  }

  return {
    ok: equal,
    mode: spec.mode,
    bytesIdentical,
    whitespaceOnly,
    sizes: {
      left: leftRaw.length,
      right: rightRaw.length,
      leftLines: leftRaw.split("\n").length,
      rightLines: rightRaw.split("\n").length,
    },
    labels: { left: labelOf(spec.left), right: labelOf(spec.right) },
    detect: { left: dl, right: dr },
    sectionDiff: { onlyLeft, onlyRight, differing },
    firstDivergence: equal ? null : firstDivergenceOf(left, right),
  };
}

const fmtN = (n: number) => n.toLocaleString("en-US");
const pct = (delta: number, base: number) => (base ? ` (${delta >= 0 ? "+" : ""}${((delta / base) * 100).toFixed(1)}%)` : "");

/** One line — goes to the console failure line and the JUnit `message=` attribute (must not contain a newline). */
export function summarizeCompare(o: CompareOutcome): string {
  const d = o.sizes.right - o.sizes.left;
  const secBits: string[] = [];
  if (o.sectionDiff.onlyLeft.length) secBits.push(`${o.sectionDiff.onlyLeft.length} in ${o.labels.left} absent from ${o.labels.right}`);
  if (o.sectionDiff.onlyRight.length) secBits.push(`${o.sectionDiff.onlyRight.length} only in ${o.labels.right}`);
  if (o.sectionDiff.differing.length) secBits.push(`${o.sectionDiff.differing.length} differ`);
  const sec = secBits.length ? secBits.join(", ") + " — " : "";
  return `compare: ${sec}${o.labels.left} ${fmtN(o.sizes.left)} chars vs ${o.labels.right} ${fmtN(o.sizes.right)} (${d >= 0 ? "+" : ""}${fmtN(d)}${pct(d, o.sizes.left)})`;
}

const CAP = 8 * 1024;
const MAX_ENTRIES = 8;

/** Multi-line report body. Plain text, no ANSI. Self-capped at ~8KB. */
export function formatCompareReport(o: CompareOutcome, opts: { width?: number } = {}): string {
  const width = Math.min(Math.max(opts.width ?? 100, 60), 120);
  const clip = (s: string) => (s.length > width - 20 ? s.slice(0, width - 21) + "…" : s);
  const L = o.labels.left.padEnd(18);
  const R = o.labels.right.padEnd(18);
  const out: string[] = [];
  out.push(`┌ compare   ${L} vs  ${R} mode: ${o.mode}`);
  const dSize = o.sizes.right - o.sizes.left;
  const dLines = o.sizes.rightLines - o.sizes.leftLines;
  out.push(`│ size     ${fmtN(o.sizes.left).padStart(10)} chars   ${fmtN(o.sizes.right).padStart(10)} chars   ${dSize >= 0 ? "+" : ""}${fmtN(dSize)}${pct(dSize, o.sizes.left)}`);
  out.push(`│ lines    ${fmtN(o.sizes.leftLines).padStart(10)}         ${fmtN(o.sizes.rightLines).padStart(10)}         ${dLines >= 0 ? "+" : ""}${fmtN(dLines)}`);

  const anyDetected = o.detect.left.source !== "none" || o.detect.right.source !== "none";
  if (anyDetected) {
    const src = o.detect.left.source !== "none" ? o.detect.left.source : o.detect.right.source;
    out.push(`│ sections ${String(o.detect.left.sections.length).padStart(10)}         ${String(o.detect.right.sections.length).padStart(10)}         (${src})`);
    const list = (title: string, mark: string, items: Section[], sideLabel: string) => {
      out.push(`├─ ${title} (${items.length})`);
      for (const s of items.slice(0, MAX_ENTRIES))
        out.push(`│   ${mark} ${s.name.padEnd(18)} ${fmtN(s.body.length).padStart(7)} chars   ${sideLabel}:${s.line}`);
      if (items.length > MAX_ENTRIES)
        out.push(`│   … ${items.length - MAX_ENTRIES} more: ${items.slice(MAX_ENTRIES).map((s) => s.name).join(", ")}`);
    };
    if (o.sectionDiff.onlyLeft.length) list(`only in ${o.labels.left}`, "✗", o.sectionDiff.onlyLeft, o.labels.left);
    if (o.sectionDiff.onlyRight.length) list(`only in ${o.labels.right}`, "✗", o.sectionDiff.onlyRight, o.labels.right);
    if (o.sectionDiff.differing.length) {
      out.push(`├─ present in both, content differs (${o.sectionDiff.differing.length})`);
      for (const d of o.sectionDiff.differing.slice(0, MAX_ENTRIES))
        out.push(`│   ~ ${d.name.padEnd(18)} ${fmtN(d.left.body.length)} → ${fmtN(d.right.body.length)} chars   ${o.labels.left}:${d.left.line} / ${o.labels.right}:${d.right.line}`);
      if (o.sectionDiff.differing.length > MAX_ENTRIES)
        out.push(`│   … ${o.sectionDiff.differing.length - MAX_ENTRIES} more`);
    }
  } else {
    out.push(`│ no section pattern detected — whole-document comparison only`);
  }

  if (o.firstDivergence) {
    const fd = o.firstDivergence;
    out.push(`└ first divergence   ${o.labels.left}:${fd.leftLine} / ${o.labels.right}:${fd.rightLine}   (byte ${fmtN(fd.byte)} of ${fmtN(o.sizes.left)})`);
    out.push(`        ${o.labels.left} │ ${clip(fd.leftText)}`);
    out.push(`        ${o.labels.right} │ ${clip(fd.rightText)}`);
    if (o.whitespaceOnly)
      out.push(`   → all differences are whitespace-only; set mode: normalized if that is not meaningful here`);
  }

  let report = out.join("\n");
  if (report.length > CAP) report = report.slice(0, CAP) + `\n… report truncated at ${fmtN(CAP)} chars`;
  return report;
}
