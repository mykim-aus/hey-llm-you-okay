/**
 * heyllm — programmatic API.
 *
 *   import { loadConfig, runSuite } from "hey-llm-you-okay";
 *   const config = await loadConfig("heyllm.yaml", { profile: "ci" });
 *   const summary = await runSuite(config, { triage: true });
 */
export { loadConfig, loadLayerCases, validateCases, ConfigError } from "./config.js";
export { runSuite } from "./runner.js";
export type { RunOptions } from "./runner.js";
export { createProviders } from "./providers/index.js";
export { captureCase } from "./capture.js";
export { triageFailures } from "./triage.js";
export { loadBaseline, saveBaseline, caseKey } from "./baseline.js";
export { matchValue, applyExpect } from "./assert.js";
export { printSummary } from "./report/console.js";
export { writeJsonReport } from "./report/json.js";
export { writeJunitReport } from "./report/junit.js";
export * from "./types.js";
