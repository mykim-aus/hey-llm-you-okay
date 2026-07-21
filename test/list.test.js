/**
 * `heyllm list` — the pipeline catalog — and the case-level `description:` field
 * it surfaces. A no-run, no-model view of what each pipeline verifies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadLayerCases, validateCases } from "../dist/index.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

const scaffold = async (yaml) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-list-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "heyllm.yaml"), yaml);
  return dir;
};
const runCli = (dir, args) => execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });
const validateProblems = async (dir) => {
  const cfg = await loadConfig(path.join(dir, "heyllm.yaml"));
  let problems = [];
  for (const layer of cfg.layers)
    problems = problems.concat(validateCases(layer, await loadLayerCases(layer, cfg.baseDir)));
  return problems;
};

// A tiny all-static (free, deterministic) suite: two described cases + one not.
const SUITE = `
providers: {}
layers:
  - name: hygiene
    kind: static
    cases:
      - name: locales-are-valid-json
        description: every locale file parses as JSON (a broken build ships blank UI)
        tags: [i18n, hygiene]
        files: ["heyllm.yaml"]
        yamlValid: true
      - name: no-merge-markers
        description: no leftover <<<<<<< conflict markers in prompt files
        tags: [hygiene]
        files: ["heyllm.yaml"]
        forbid: ["^<<<<<<< "]
  - name: units
    kind: exec
    cases:
      - name: jest
        command: "true"
`;

test("`description:` is accepted on a case and is NOT an unknown-key error", async () => {
  const dir = await scaffold(SUITE);
  const problems = await validateProblems(dir);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a non-string description is a validate error (a mis-indented block, not a note)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: s
    kind: static
    cases:
      - name: bad
        description: { status: 200 }   # a mapping slipped in where a string belongs
        files: ["heyllm.yaml"]
        yamlValid: true
`);
  const problems = await validateProblems(dir);
  assert.ok(problems.some((p) => /'description' must be a string/.test(p)), problems.join("\n"));
});

test("`heyllm list` prints each case's name + description + tags, grouped by pipeline", () => {
  return scaffold(SUITE).then((dir) => {
    const out = runCli(dir, ["list", "--no-color"]);
    assert.match(out, /hygiene/);
    assert.match(out, /locales-are-valid-json/);
    assert.match(out, /every locale file parses as JSON/); // the description line
    assert.match(out, /#i18n #hygiene/); // tags
    assert.match(out, /units/);
    assert.match(out, /jest/);
    // the exec case has no description → the nudge, and the gap counter
    assert.match(out, /no description/);
    assert.match(out, /1\/3 cases? (?:has|have) no description/);
  });
});

test("`heyllm list --json` is machine-readable with per-case description + totals", async () => {
  const dir = await scaffold(SUITE);
  const j = JSON.parse(runCli(dir, ["list", "--json"]));
  assert.equal(j.totals.pipelines, 2);
  assert.equal(j.totals.cases, 3);
  assert.equal(j.totals.undescribed, 1); // the exec 'jest' case
  const hygiene = j.pipelines.find((p) => p.name === "hygiene");
  const c0 = hygiene.cases.find((c) => c.name === "locales-are-valid-json");
  assert.match(c0.description, /parses as JSON/);
  assert.deepEqual(c0.tags, ["i18n", "hygiene"]);
  const jestCase = j.pipelines.find((p) => p.name === "units").cases[0];
  assert.equal(jestCase.description, null); // undescribed → null, not missing
});

test("--only filters pipelines; --tags keeps only tagged cases; --grep filters by name", async () => {
  const dir = await scaffold(SUITE);
  // --only
  const only = JSON.parse(runCli(dir, ["list", "--json", "--only", "hygiene"]));
  assert.deepEqual(only.pipelines.map((p) => p.name), ["hygiene"]);
  // --tags: only cases carrying i18n survive; the pipeline with none is dropped
  const tagged = JSON.parse(runCli(dir, ["list", "--json", "--tags", "i18n"]));
  assert.deepEqual(tagged.pipelines.map((p) => p.name), ["hygiene"]);
  assert.deepEqual(tagged.pipelines[0].cases.map((c) => c.name), ["locales-are-valid-json"]);
  // --grep by case name
  const grepped = JSON.parse(runCli(dir, ["list", "--json", "--grep", "merge"]));
  assert.deepEqual(grepped.pipelines[0].cases.map((c) => c.name), ["no-merge-markers"]);
});

test("a filter that matches nothing exits 2 (not a silent empty catalog)", async () => {
  const dir = await scaffold(SUITE);
  let code = 0;
  try {
    execFileSync("node", [CLI, "list", "--tags", "does-not-exist"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2);
});

test("`ls` is an alias for the catalog (list), not the results dashboard", async () => {
  const dir = await scaffold(SUITE);
  const out = runCli(dir, ["ls", "--no-color"]);
  assert.match(out, /catalog · no runs/); // the list header, not the pipelines dashboard
  assert.match(out, /locales-are-valid-json/);
});
