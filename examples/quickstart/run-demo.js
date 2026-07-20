/**
 * Offline end-to-end demo (no API keys):
 *   1. start the mock backend
 *   2. GREEN run + --update-baseline  → prompt snapshots recorded
 *   3. flip the mock into "drift mode" (simulated silent model update)
 *   4. `heyllm triage`               → conversation case fails, verdict: MODEL-DRIFT
 *   5. capture a production complaint into the corpus ledger
 */
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "../../dist/cli.js");
const PORT = 4141;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("mock server did not start");
}

function heyllm(args) {
  console.log(`\n$ heyllm ${args.join(" ")}\n`);
  try {
    execFileSync("node", [cli, ...args], { cwd: here, stdio: "inherit" });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

// clean state so the demo is reproducible
rmSync(path.join(here, ".heyllm"), { recursive: true, force: true });
rmSync(path.join(here, "tests/captured.yaml"), { force: true });

const server = spawn("node", [path.join(here, "mock-server.js")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
try {
  await waitHealthy();

  console.log("═".repeat(70));
  console.log(" STEP 1 — green pyramid run, snapshots recorded (--update-baseline)");
  console.log("═".repeat(70));
  const green = heyllm(["run", "--update-baseline"]);
  if (green !== 0) throw new Error("expected the baseline run to pass");

  console.log("\n" + "═".repeat(70));
  console.log(' STEP 2 — the provider "updates its model over the weekend" (drift ON)');
  console.log("═".repeat(70));
  await fetch(`http://127.0.0.1:${PORT}/__config`, { method: "POST", body: '{"drift":true}' });
  console.log("(mock: chatbot silently loses multi-turn context)");

  console.log("\n" + "═".repeat(70));
  console.log(" STEP 3 — heyllm triage: is it OUR prompt or THEIR model?");
  console.log("═".repeat(70));
  const red = heyllm(["triage"]);
  if (red === 0) throw new Error("expected the drifted run to fail");

  await fetch(`http://127.0.0.1:${PORT}/__config`, { method: "POST", body: '{"drift":false}' });

  console.log("\n" + "═".repeat(70));
  console.log(" STEP 4 — capture a production complaint into the corpus ledger");
  console.log("═".repeat(70));
  heyllm([
    "capture",
    "it keeps going off-topic when I ask about the refund policy",
    "--tags",
    "prod,refund",
    "--note",
    "CS ticket #4821",
  ]);
  heyllm(["validate"]);

  console.log("\n✅ demo complete — pyramid, gates, judge, triage(MODEL-DRIFT), capture all live.");
} finally {
  server.kill("SIGKILL");
}
