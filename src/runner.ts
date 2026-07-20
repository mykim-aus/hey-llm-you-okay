/**
 * The Full-Stack Pyramid Runner.
 *
 * Layers execute in YAML order — put cheap ones first. When a GATED layer
 * fails, later layers are HALTED (never burn LLM tokens on a build whose
 * unit tests are already red). `--keep-going` overrides.
 *
 * After the run, failed llm/judge cases can be handed to the triage engine
 * (--triage) for the A/B failure-cause probe.
 */
import path from "node:path";
import { loadLayerCases } from "./config.js";
import { createProviders } from "./providers/index.js";
import { runStaticCase } from "./layers/static.js";
import { runExecCase } from "./layers/exec.js";
import { runHttpCase } from "./layers/http.js";
import { runLlmCase } from "./layers/llm.js";
import { runJudgeCase } from "./layers/judge.js";
import {
  caseKey,
  checkRegression,
  loadBaseline,
  recordScore,
  recordSnapshot,
  saveBaseline,
} from "./baseline.js";
import { triageFailures } from "./triage.js";
import type {
  CaseCtx,
  CaseDef,
  CaseResult,
  CaseRunRecord,
  HaechiConfig,
  LayerConfig,
  LayerKind,
  LayerRunResult,
  Provider,
  RunSummary,
} from "./types.js";
import { makeLookup, pool } from "./util.js";

const RUNNERS: Record<LayerKind, (cs: CaseDef, ctx: CaseCtx) => Promise<CaseResult>> = {
  static: runStaticCase,
  exec: runExecCase,
  http: runHttpCase,
  llm: runLlmCase,
  judge: runJudgeCase,
};

// http defaults to 1 (save-chaining is sequential); llm/judge stay low for rate limits
const DEFAULT_CONCURRENCY: Record<LayerKind, number> = {
  static: 8,
  exec: 1,
  http: 1,
  llm: 2,
  judge: 2,
};

export interface RunOptions {
  only?: string[];
  grep?: string;
  tags?: string[];
  keepGoing?: boolean;
  updateBaseline?: boolean;
  triage?: boolean;
  log?: (line: string) => void;
  /** live progress callback for reporters */
  onCase?: (layer: LayerConfig, record: CaseRunRecord) => void;
  onLayerStart?: (layer: LayerConfig, caseCount: number) => void;
}

export async function runSuite(config: HaechiConfig, opts: RunOptions = {}): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  const providers = createProviders(config.providers);
  const startedAt = new Date();
  const layerResults: LayerRunResult[] = [];
  const halted: string[] = [];
  const baseline = await loadBaseline(config.baseDir);
  const maxDrop = config.settings.maxDrop ?? 1;
  let gateBroken = false;

  const makeCtx = (layer: LayerConfig, baseDir: string, saved: Record<string, unknown> = {}): CaseCtx => ({
    layer,
    providers,
    baseDir,
    saved,
    lookup: makeLookup(layer.vars, saved),
    config,
  });

  for (const layer of config.layers) {
    if (opts.only?.length && !opts.only.includes(layer.name)) continue;
    if (gateBroken && !opts.keepGoing) {
      halted.push(layer.name);
      continue;
    }

    const started = Date.now();
    // missing required env: gated layers fail loudly, others skip quietly
    const missingEnv = (layer.env || []).filter((e) => !process.env[e]);
    if (missingEnv.length) {
      const msg = `missing env: ${missingEnv.join(", ")}`;
      layerResults.push({
        name: layer.name,
        kind: layer.kind,
        gate: layer.gate,
        ok: !layer.gate,
        skipped: msg,
        durationMs: 0,
        cases: [],
      });
      if (layer.gate) gateBroken = true;
      continue;
    }

    const groups = await loadLayerCases(layer, config.baseDir);
    const saved: Record<string, unknown> = {}; // save-chaining scope: whole layer
    const flat: Array<{ def: CaseDef; file: string | null; baseDir: string }> = [];
    for (const g of groups) {
      const dir = g.file ? path.dirname(g.file) : config.baseDir;
      for (const def of g.cases) flat.push({ def, file: g.file, baseDir: dir });
    }
    const grepRe = opts.grep ? new RegExp(opts.grep) : null;
    const selected = flat.filter(({ def }) => {
      if (grepRe && !grepRe.test(def.name)) return false;
      if (opts.tags?.length && !opts.tags.some((t) => (def.tags || []).includes(t))) return false;
      return true;
    });
    opts.onLayerStart?.(layer, selected.length);

    const concurrency = layer.concurrency ?? DEFAULT_CONCURRENCY[layer.kind];
    const records = await pool(selected, concurrency, async ({ def, file, baseDir }) => {
      const caseStarted = Date.now();
      let result: CaseResult;
      if (def.skip) {
        result = { ok: true, failures: [], skipped: typeof def.skip === "string" ? def.skip : "skipped" };
      } else {
        const ctx = makeCtx(layer, baseDir, saved);
        try {
          result = await RUNNERS[layer.kind](def, ctx);
        } catch (e: any) {
          result = { ok: false, failures: [{ path: "runner", message: e.message }] };
        }
        // judge baseline regression (runner owns the baseline file)
        if (layer.kind === "judge" && result.score !== undefined && layer.baseline !== false) {
          const key = caseKey(layer.name, def.name);
          const drop = layer.maxDrop ?? maxDrop;
          const reg = checkRegression(baseline, key, result.score, drop);
          if (reg.regressed) {
            result.ok = false;
            result.failures.push({
              path: "baseline",
              message: `score ${result.score} dropped more than ${drop} below baseline ${reg.baselineScore}`,
            });
          }
        }
      }
      const record: CaseRunRecord = {
        name: def.name,
        tags: def.tags || [],
        file,
        durationMs: Date.now() - caseStarted,
        result,
        def,
        baseDir,
      };
      opts.onCase?.(layer, record);
      return record;
    });

    // successful llm/judge cases refresh the triage snapshot + judge scores
    if (opts.updateBaseline) {
      for (const r of records) {
        if (!r.result.ok || r.result.skipped) continue;
        const key = caseKey(layer.name, r.name);
        if (r.result.score !== undefined && r.result.scale)
          recordScore(baseline, key, r.result.score, r.result.scale);
        if (r.result.resolvedInputs) {
          const providerName = (layer.kind === "llm" ? layer.provider : layer.subject) as string;
          recordSnapshot(baseline, key, {
            provider: providerName,
            model: providers[providerName]?.model,
            inputs: r.result.resolvedInputs,
            score: r.result.score,
          });
        }
      }
    }

    const ok = records.every((r) => r.result.ok);
    layerResults.push({
      name: layer.name,
      kind: layer.kind,
      gate: layer.gate,
      ok,
      durationMs: Date.now() - started,
      cases: records,
    });
    if (!ok && layer.gate) gateBroken = true;
  }

  if (opts.updateBaseline) {
    const file = await saveBaseline(config.baseDir, baseline);
    log(`baseline updated: ${file}`);
  }

  const summary: RunSummary = {
    ok: layerResults.every((l) => l.ok || !l.gate),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    profile: config.profile,
    layers: layerResults,
    halted,
  };

  if (opts.triage) {
    const failed = layerResults.flatMap((lr) => {
      const layer = config.layers.find((l) => l.name === lr.name)!;
      return lr.cases
        .filter((r) => !r.result.ok && (layer.kind === "llm" || layer.kind === "judge"))
        .map((record) => ({ layer, record }));
    });
    if (failed.length) {
      log(`entering triage mode for ${failed.length} failed AI case(s)…`);
      summary.triage = await triageFailures(config, providers, failed, (layer, baseDir) => makeCtx(layer, baseDir), log);
    }
  }

  return summary;
}

export type { Provider };
