/**
 * Unit tests for the compare engine (dist/compare.js) — pure functions, no fs.
 * The integration path (static layer resolving refs, empty-side/mixed-type
 * guards) is covered in test/layers.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runCompare,
  summarizeCompare,
  formatCompareReport,
  detectSections,
  normalizeCompareSpec,
} from "../dist/compare.js";

const spec = (o = {}) => ({ left: "exec:x", right: "exec:y", mode: "normalized", ...o });

// The case-study shape: 11 sections vs a 2-section subset.
function sectionedText(names) {
  return names.map((n) => `## ${n}\nbody of ${n}\n`).join("\n");
}

test("case-study shape: 9 sections present in left are absent from right", () => {
  const all = ["persona", "memory", "recentSession", "reviewVocab", "toolPolicy", "examples", "closing", "safety", "date", "identity", "tools"];
  const left = sectionedText(all);
  const right = sectionedText(["safety", "date"]);
  const o = runCompare(spec(), left, right);
  assert.equal(o.ok, false);
  assert.equal(o.sectionDiff.onlyLeft.length, 9);
  const names = o.sectionDiff.onlyLeft.map((s) => s.name);
  assert.ok(names.includes("persona") && names.includes("reviewVocab"));
});

test("summarizeCompare is a single line (JUnit message= attribute)", () => {
  const o = runCompare(spec(), sectionedText(["a", "b", "c"]), sectionedText(["a"]));
  const s = summarizeCompare(o);
  assert.ok(!s.includes("\n"), "summary must be one line");
  assert.match(s, /absent from/);
});

test("formatCompareReport names missing sections and stays under 8KB on huge input", () => {
  const many = Array.from({ length: 400 }, (_, i) => `sec${i}`);
  const left = sectionedText(many);
  const right = sectionedText(many.slice(0, 5));
  const o = runCompare(spec(), left, right);
  const rep = formatCompareReport(o);
  assert.ok(rep.length <= 8 * 1024 + 200, `report was ${rep.length} bytes`);
  assert.match(rep, /more:/, "must report the count it truncated");
});

test("detectSections: markdown auto, explicit override, and none for prose", () => {
  const md = detectSections("## a\nx\n## b\ny");
  assert.equal(md.source, "auto");
  assert.equal(md.sections.length, 2);
  const prose = detectSections("just some prose with no headings at all");
  assert.equal(prose.source, "none");
  const configured = detectSections("[a]\nx\n[b]\ny", "^\\[([a-z]+)\\]$");
  assert.equal(configured.source, "configured");
  assert.equal(configured.sections.length, 2);
});

test("normalized mode: trailing whitespace differences pass, bytesIdentical is false", () => {
  const o = runCompare(spec(), "line one   \nline two\n", "line one\nline two");
  assert.equal(o.ok, true, "whitespace-only diff must pass under normalized");
  assert.equal(o.bytesIdentical, false);
  assert.equal(o.whitespaceOnly, true);
});

test("exact mode: the same whitespace difference fails", () => {
  const o = runCompare(spec({ mode: "exact" }), "line one   \n", "line one\n");
  assert.equal(o.ok, false);
  assert.equal(o.whitespaceOnly, true);
});

test("byte-identical inputs pass with bytesIdentical true", () => {
  const o = runCompare(spec(), "same\ntext", "same\ntext");
  assert.equal(o.ok, true);
  assert.equal(o.bytesIdentical, true);
  assert.equal(o.firstDivergence, null);
});

test("first divergence carries a byte offset and per-side line", () => {
  const o = runCompare(spec({ mode: "exact" }), "aaa\nbbb\nCCC", "aaa\nbbb\nDDD");
  assert.equal(o.ok, false);
  assert.ok(o.firstDivergence);
  assert.equal(o.firstDivergence.leftLine, 3);
  assert.equal(o.firstDivergence.rightLine, 3);
});

// normalizeCompareSpec — the load-bearing validator (runs at BOTH validate and run time).
test("normalizeCompareSpec rejects non-ref sides, bad mode, and unknown keys", () => {
  assert.ok(Array.isArray(normalizeCompareSpec({ left: "prompts/x", right: "exec:y" }, "at")), "bare path must be rejected");
  assert.ok(Array.isArray(normalizeCompareSpec({ left: "file:a", right: "file:b", mode: "fuzzy" }, "at")));
  const unknownKey = normalizeCompareSpec({ left: "file:a", right: "file:b", ignroe: [] }, "at");
  assert.ok(Array.isArray(unknownKey) && unknownKey.some((p) => /unknown compare key/.test(p)));
  const ok = normalizeCompareSpec({ left: "file:a", right: "exec:b" }, "at");
  assert.ok(!Array.isArray(ok) && ok.mode === "normalized", "valid spec defaults mode to normalized");
});

test("normalizeCompareSpec requires exactly one capture group in sections", () => {
  assert.ok(Array.isArray(normalizeCompareSpec({ left: "file:a", right: "file:b", sections: "^##.+$" }, "at")), "zero groups rejected");
  assert.ok(Array.isArray(normalizeCompareSpec({ left: "file:a", right: "file:b", sections: "^(#)(#)$" }, "at")), "two groups rejected");
  const one = normalizeCompareSpec({ left: "file:a", right: "file:b", sections: "^#\\s+(.+)$" }, "at");
  assert.ok(!Array.isArray(one));
});
