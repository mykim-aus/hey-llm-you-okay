/**
 * exec `parseStdout` — a command (e.g. a Playwright/Puppeteer browser check)
 * prints JSON on stdout; the exec case asserts it with json/jsonPath. Browser/
 * DOM coverage without heyllm shipping a browser dependency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runSuite } from "../dist/index.js";

const scaffold = async (yaml) => {
  const dir = await mkdtemp(path.join(tmpdir(), "heyllm-execj-"));
  await writeFile(path.join(dir, "heyllm.yaml"), yaml);
  return dir;
};
const run = async (dir) => runSuite(await loadConfig(path.join(dir, "heyllm.yaml")));
const caseOf = (s, l, n) => s.layers.find((x) => x.name === l)?.cases.find((c) => c.name === n);

test("parseStdout lets a browser-check script's JSON be asserted", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: browser
    kind: exec
    cases:
      - name: panel-visible-after-click
        command: "echo '{\\"panelVisible\\": true, \\"items\\": 3}'"
        parseStdout: true
        expect:
          json: { panelVisible: true, items: 3 }
`);
  const r = caseOf(await run(dir), "browser", "panel-visible-after-click").result;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("parseStdout fails clearly when stdout is not JSON", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: browser
    kind: exec
    cases:
      - name: bad-json
        command: "echo not-json"
        parseStdout: true
        expect: { json: { x: 1 } }
`);
  const r = caseOf(await run(dir), "browser", "bad-json").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /not valid JSON/);
});

test("json without parseStdout is still rejected (points to parseStdout)", async () => {
  const dir = await scaffold(`
providers: {}
layers:
  - name: e
    kind: exec
    cases:
      - name: c
        command: "echo hi"
        expect: { json: { x: 1 } }
`);
  const r = caseOf(await run(dir), "e", "c").result;
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /parseStdout: true/);
});
