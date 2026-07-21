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
import { runDispatchCase } from "./layers/dispatch.js";
import {
  caseKey,
  checkRegression,
  loadBaseline,
  recordScore,
  recordSnapshot,
  saveBaseline,
} from "./baseline.js";
import { triageFailures } from "./triage.js";
import { TokenMeter, summarizeUsage } from "./usage.js";
import { loadLedger, recordObservation, saveLedger } from "./ledger.js";
import { loadPromptStore, savePromptStore } from "./changed.js";
import type {
  CaseCtx,
  CaseDef,
  CaseResult,
  CaseRunRecord,
  HeyLLMConfig,
  LayerConfig,
  LayerKind,
  LayerRunResult,
  Provider,
  InfraProblem,
  RunSummary,
} from "./types.js";
import { makeLookup, pool } from "./util.js";

const RUNNERS: Record<LayerKind, (cs: CaseDef, ctx: CaseCtx) => Promise<CaseResult>> = {
  static: runStaticCase,
  exec: runExecCase,
  http: runHttpCase,
  llm: runLlmCase,
  judge: runJudgeCase,
  dispatch: runDispatchCase,
};

// http defaults to 1 (save-chaining is sequential); llm/judge stay low for rate limits
const DEFAULT_CONCURRENCY: Record<LayerKind, number> = {
  static: 8,
  dispatch: 8,
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
  /** --changed-only: skip llm/judge cases whose resolved payload is unchanged */
  changedOnly?: boolean;
  /** layer names that must run every time even under --changed-only (canaries) */
  always?: string[];
  log?: (line: string) => void;
  /** live progress callback for reporters */
  onCase?: (layer: LayerConfig, record: CaseRunRecord) => void;
  onLayerStart?: (layer: LayerConfig, caseCount: number) => void;
}

export async function runSuite(config: HeyLLMConfig, opts: RunOptions = {}): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  // One meter per run (never module-global — that would cross-count concurrent
  // runs). Cases get a scoped provider view via makeCtx, so every chat call —
  // including triage arms — is attributed without threading usage through eight
  // call signatures where a new path could silently escape metering.
  const meter = new TokenMeter();
  const providers = createProviders(config.providers);
  const startedAt = new Date();
  const layerResults: LayerRunResult[] = [];
  const halted: string[] = [];
  const baseline = await loadBaseline(config.baseDir);
  // The reliability ledger is written on EVERY run, pass or fail — a history
  // that only remembers successes ratchets to the top of the distribution and
  // then flags ordinary runs as regressions.
  const ledger = await loadLedger(config.baseDir);
  let ledgerDirty = false;
  // --changed-only: payload fingerprints from prior runs, so an unchanged case
  // can skip its paid call. Populated on EVERY run (whether or not --changed-only
  // is set) so the flag has a baseline to compare against next time.
  const promptStore = await loadPromptStore(config.baseDir);
  let promptStoreDirty = false;
  const alwaysSet = new Set(opts.always || []);
  const maxDrop = config.settings.maxDrop ?? 1;
  let gateBroken = false;

  const makeCtx = (
    layer: LayerConfig,
    baseDir: string,
    saved: Record<string, unknown> = {},
    scope: { case?: string; phase?: "run" | "triage" } = {}
  ): CaseCtx => {
    // Only the env vars a layer DECLARES are interpolatable — never all of
    // process.env (prompt pollution + secrets leaking into the baseline).
    const envScope = Object.fromEntries(
      (layer.env || []).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])
    );
    return {
      layer,
      // scoped provider view: each case holds its own closure, so concurrent
      // cases record their tokens against themselves with no interleaving.
      providers: meter.scope({ layer: layer.name, case: scope.case, phase: scope.phase ?? "run" }, providers),
      baseDir,
      saved,
      lookup: makeLookup(envScope, layer.vars, saved),
      config,
      ledger,
      changedOnly: opts.changedOnly,
      alwaysRun: alwaysSet.has(layer.name),
      promptStore,
      nowMs: startedAt.getTime(), // one clock per run for cache-age checks
    };
  };

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

    // A layer may name a provider that only some profile supplies (that is how
    // paid layers stay out of the default run). Config validation accepts it;
    // running without that profile has to say so, not crash on `undefined.chat`
    // and not quietly pass.
    const providerRefs = (
      layer.kind === "llm" ? [layer.provider] : layer.kind === "judge" ? [layer.subject, layer.judge] : []
    ).filter(Boolean) as string[];
    const absent = providerRefs.filter((r) => !providers[r]);
    if (absent.length) {
      const msg =
        `provider ${absent.map((a) => `'${a}'`).join(", ")} is not defined` +
        (config.profile ? ` in profile '${config.profile}'` : " without a profile") +
        ` — this layer needs a profile that supplies it (try --profile <name>)`;
      layerResults.push({
        name: layer.name,
        kind: layer.kind,
        gate: layer.gate,
        ok: false,
        durationMs: 0,
        cases: [
          {
            name: `layer:${layer.name}`,
            tags: [],
            file: null,
            durationMs: 0,
            def: { name: `layer:${layer.name}` } as CaseDef,
            baseDir: config.baseDir,
            result: { ok: false, failures: [{ path: "provider", message: msg, infra: true }] },
          },
        ],
      });
      if (layer.gate) gateBroken = true;
      continue;
    }

    const groups = await loadLayerCases(layer, config.baseDir, config.settings?.capture?.file);
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
        const ctx = makeCtx(layer, baseDir, saved, { case: def.name });
        try {
          result = await RUNNERS[layer.kind](def, ctx);
        } catch (e: any) {
          result = { ok: false, failures: [{ path: "runner", message: e.message }] };
        }
        // record run-axis observations regardless of pass/fail (see above)
        for (const o of result.ledgerObservations || []) {
          recordObservation(ledger, o.key, o.fp, o.obs);
          ledgerDirty = true;
        }
        // Record the payload fingerprint ONLY for a case that actually ran AND
        // passed. Recording on failure would let a red case be skipped as
        // "unchanged" on the next --changed-only run — a broken test must keep
        // re-running until it is green. A skipped-unchanged case (result.skipped)
        // did not run, so its stored timestamp is left untouched.
        if (result.promptFingerprint && result.ok && !result.skipped && !result.cached) {
          promptStore.cases[result.promptFingerprint.key] = {
            fp: result.promptFingerprint.fp,
            at: startedAt.toISOString(),
            // carry the output so a future --changed-only run can replay the
            // assertions against it instead of paying for a model call
            ...(result.promptFingerprint.output ? { output: result.promptFingerprint.output } : {}),
          };
          promptStoreDirty = true;
        }
        // judge baseline regression (runner owns the baseline file).
        // Skipped when the verdict is INCONCLUSIVE — we do not compare against
        // a number we just said we cannot trust.
        if (
          layer.kind === "judge" &&
          result.score !== undefined &&
          !result.inconclusive &&
          layer.baseline !== false
        ) {
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
        // absent key (not an all-zero object) when the case made no model calls
        ...(meter.hasCalls(layer.name, def.name) ? { usage: summarizeUsage(meter.forCase(layer.name, def.name)) } : {}),
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
      ...(meter.hasCalls(layer.name) ? { usage: summarizeUsage(meter.forLayer(layer.name)) } : {}),
    });
    if (!ok && layer.gate) gateBroken = true;
  }

  if (ledgerDirty) await saveLedger(config.baseDir, ledger);
  // Stamp the last FULL sweep (no layer/tag/grep filter) so a caller can tell
  // how stale --changed-only skips are relative to possible model drift.
  const fullRun = !opts.only?.length && !opts.tags?.length && !opts.grep;
  if (fullRun) {
    promptStore.lastFullRunAt = startedAt.toISOString();
    promptStoreDirty = true;
  }
  if (promptStoreDirty) await savePromptStore(config.baseDir, promptStore);
  if (opts.updateBaseline) {
    const file = await saveBaseline(config.baseDir, baseline);
    log(`baseline updated: ${file}`);
  }

  // A provider we could not reach produced no verdict at all, so it must not be
  // absorbed by a non-gated layer the way a wrong answer is. Collected across
  // every layer regardless of `gate`, and it forces `ok: false` on its own.
  const infra: InfraProblem[] = layerResults.flatMap((lr) =>
    lr.cases.flatMap((r) =>
      (r.result.failures || [])
        .filter((f) => f.infra)
        .map((f) => ({
          layer: lr.name,
          case: r.name,
          provider: f.path === "provider" ? undefined : f.path,
          message: f.message,
        }))
    )
  );

  const summary: RunSummary = {
    ok: layerResults.every((l) => l.ok || !l.gate) && !infra.length,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    profile: config.profile,
    layers: layerResults,
    halted,
    ...(infra.length ? { infra } : {}),
  };

  if (opts.triage) {
    const failed = layerResults.flatMap((lr) => {
      const layer = config.layers.find((l) => l.name === lr.name)!;
      return lr.cases
        // An input-contract failure is deterministic and already names its own
        // fix. The A/B probe re-runs the case through produceLlm directly, with
        // the contract not applied — so it would "pass" both arms and report a
        // confident FLAKY for a case that has not been measured at all.
        .filter(
          (r) =>
            !r.result.ok &&
            (layer.kind === "llm" || layer.kind === "judge") &&
            !(r.result.failures || []).some((f) => f.path === "inputs.system" || f.path === "inputs")
        )
        .map((record) => ({ layer, record }));
    });
    if (failed.length) {
      log(`entering triage mode for ${failed.length} failed AI case(s)…`);
      // phase: "triage" so the A/B probe's own token spend is counted and
      // attributed as triage, not folded into the original run silently.
      summary.triage = await triageFailures(config, providers, failed, (layer, baseDir) => makeCtx(layer, baseDir, {}, { phase: "triage" }), log);
    }
  }

  // Computed AFTER triage, so triage's own spend is in the run total.
  if (meter.hasCalls()) summary.usage = summarizeUsage(meter.all());

  return summary;
}

export type { Provider };
