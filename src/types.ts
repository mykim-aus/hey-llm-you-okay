/**
 * Core shared types for HeyLLM.
 *
 * YAML-shaped data (cases, expects) is intentionally loose (`Record<string,
 * unknown>` / `any` at the edges) — the config validator narrows it at load
 * time, and the matcher engine treats specs as data.
 */

// ── chat protocol (normalized across providers) ───────────────────
export type ChatRole = "user" | "assistant" | "tool";

export interface ToolDecl {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  /** provider-neutral opaque signature that must be echoed back on the next
   *  request (Gemini 3 thoughtSignature); ignored by other providers */
  signature?: string;
}

export interface ToolResult {
  id?: string;
  name: string;
  response: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDecl[];
  /** null = omit the parameter entirely (reasoning models reject it) */
  temperature?: number | null;
  maxTokens?: number;
  /** ask the provider for JSON-mode output when supported */
  json?: boolean;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** reasoning/thinking tokens, for visibility. Already inside outputTokens on
   *  OpenAI/Anthropic; on Gemini it is reported separately and folded into
   *  output by the adapter (a count-correctness fix, not pricing). */
  reasoningTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  usage?: TokenUsage;
}

export interface UsageBucket {
  provider: string;
  model?: string;
  kind: ProviderKind;
  calls: number;
  /** calls whose provider reported no usage at all */
  unmetered: number;
  /** calls that reported only a total, no input/output split */
  unsplit: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageTotals {
  calls: number;
  unmetered: number;
  unsplit: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  /** false ⇒ some call went unmetered or unsplit, so in/out sums are a FLOOR */
  complete: boolean;
  buckets: UsageBucket[];
}

export interface Provider {
  name: string;
  kind: ProviderKind;
  model?: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ── config ────────────────────────────────────────────────────────
export type ProviderKind = "openai-compatible" | "anthropic" | "gemini" | "command";

export interface ProviderConfig {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
  /** name of the env var holding the API key — keys never live in YAML */
  apiKeyEnv?: string;
  /** resolved at createProviders() time; do not set in YAML */
  apiKey?: string;
  timeoutMs?: number;
  retries?: number;
  maxTokens?: number;
  apiVersion?: string;
  /** force-omit the temperature parameter (models that reject sampling params) */
  omitTemperature?: boolean;
  /** openai-compatible: which max-tokens field this server accepts */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** gemini: merged into generationConfig verbatim (e.g. thinkingConfig) */
  generationConfig?: Record<string, unknown>;
  // command kind
  command?: string;
  args?: string[];
  outputPath?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export type LayerKind = "static" | "exec" | "http" | "llm" | "judge" | "dispatch";

export interface Scale {
  min: number;
  max: number;
}

export interface JudgeParams {
  /** null = omit the parameter entirely (reasoning models reject it) */
  temperature?: number | null;
  maxTokens?: number;
}

export interface RubricItem {
  id: string;
  question: string;
  weight?: number;
  /** decision rules for the grey zone. Without these the judge re-invents the
   *  policy on every call — the actual cause of the 2-vs-9 disagreement. */
  rules?: string[];
  /** "scale" (default, min..max) or "binary" (pass/fail). Binary removes the
   *  grey zone that makes judges disagree on fuzzy surface properties. */
  ask?: "scale" | "binary";
  /** require the judge to quote the exact violating span from the output; the
   *  quote is verified against the real text, so fabricated evidence is
   *  discarded instead of scored */
  citeSpan?: boolean;
}

/** Judge trustworthiness gate. A verdict nobody can reproduce is not a verdict. */
export interface ReliabilityConfig {
  /** max allowed spread (max-min) before the verdict is refused. Applies to
   *  BOTH axes: votes within a run, and scores across remembered runs. */
  maxSpread?: number;
  /** set false to score anyway and only warn */
  enforce?: boolean;
  /** how many remembered runs before the run-axis check activates (default 3) */
  minRuns?: number;
  /** set false to skip the run-axis ledger entirely */
  ledger?: boolean;
}

/** How a model response is folded into application state. */
/** Exactly one of `module` (JS) or `command` (any language, over a JSON pipe). */
export interface DispatchSpec {
  /** path to a module exporting the reducer, relative to the case file */
  module?: string;
  /** named export to use (default: the default export) */
  export?: string;
  /** subprocess reducer: argv[0]. Spawned directly — no shell, no word splitting */
  command?: string;
  /** subprocess reducer: argv[1..] */
  args?: string[];
  /** subprocess reducer: working dir (default: the case file's dir) */
  cwd?: string;
  /** subprocess reducer: extra env vars for the child */
  env?: Record<string, string>;
  /** subprocess reducer: per-call timeout (default 30000) */
  timeoutMs?: number;
  initialState?: unknown;
  expect?: Record<string, unknown>;
}

/** A case is YAML-authored; `name` is the only universally required field. */
export type CaseDef = Record<string, any> & {
  name: string;
  tags?: string[];
  /** true, or a reason string shown as the skip note (ingested stubs use this) */
  skip?: boolean | string;
  /** static layer: assert two artifacts (file:/exec: refs) are the same */
  compare?: CompareSpec;
  /** provenance for a case bulk-imported by `heyllm ingest` */
  source?: Record<string, unknown>;
};

export interface CompareSpec {
  left: string;
  right: string;
  mode: "exact" | "normalized";
  /** regex with one capture group naming a section; markdown auto-detected if omitted */
  sections?: string;
}

export interface LayerConfig {
  name: string;
  kind: LayerKind;
  include?: string | string[];
  cases?: CaseDef[];
  /** gated layers fail the run AND stop the pyramid (cheap → expensive) */
  gate: boolean;
  /** llm layer */
  provider?: string;
  /** judge layer */
  subject?: string;
  judge?: string;
  env?: string[];
  vars?: Record<string, unknown>;
  concurrency?: number;
  repeat?: number;
  passRate?: number;
  votes?: number;
  threshold?: number;
  scale?: Scale;
  judgeParams?: JudgeParams;
  reliability?: ReliabilityConfig;
  /** enable score-regression checks against the baseline file */
  baseline?: boolean;
  maxDrop?: number;
  /** llm/judge — contract on where each case's system prompt must come from */
  inputs?: InputsContract;
}

/** A claim about what every case in a layer must SEND. A test that builds its
 *  own prompt is testing a program you do not ship — this makes the suite state,
 *  and the tool enforce, that its cases use production's real prompt path. */
export interface InputsContract {
  /** required = any non-empty · file = file:/exec: ref · exec = exec: ref only */
  system?: "required" | "file" | "exec";
}

export interface TriageSettings {
  /** attempts per A/B arm (default 3) */
  repeat?: number;
  /** where the "old" artifact comes from (default: snapshot, git fallback) */
  source?: "snapshot" | "git";
  /** git ref for the old artifact (default: HEAD) */
  gitRef?: string;
}

export interface CaptureSettings {
  /** ledger file the `capture` command appends to */
  file?: string;
  /** which layer's kind/shape captured cases follow (default: first llm layer) */
  layer?: string;
  /** merged into every captured case (e.g. a default expect or judge wiring) */
  defaults?: Record<string, unknown>;
}

export interface Settings {
  maxDrop?: number;
  triage?: TriageSettings;
  capture?: CaptureSettings;
  /** .env file(s) to load before running; real env vars always win */
  envFile?: string | string[];
}

export interface HeyLLMConfig {
  file: string;
  baseDir: string;
  version: 1;
  profile: string | null;
  providers: Record<string, ProviderConfig>;
  layers: LayerConfig[];
  settings: Settings;
}

// ── execution results ─────────────────────────────────────────────
export interface Failure {
  path?: string;
  message: string;
  /** The provider could not be reached, authenticated, or understood — so the
   *  model never answered and this case has NO verdict, passing or failing.
   *  Distinct from a wrong answer, and never silenced by a non-gated layer.  */
  infra?: boolean;
}

export interface VoteResult {
  weighted: number;
  scores: Record<string, number>;
  reasoning: string;
  /** quoted evidence per rubric id (citeSpan), already verified against output */
  spans?: Record<string, string>;
}

/** Per-rubric-item agreement on BOTH axes — the numbers nobody else reports.
 *  `spread` is within-run (votes); `runAxis` is across remembered runs, which
 *  is where instability actually showed up in practice. */
export interface AgreementReport {
  spread: number;
  perItem: Record<string, { min: number; max: number; spread: number }>;
  worstItem: string | null;
  runAxis?: {
    item: string;
    spread: number;
    runs: number;
    min: number;
    max: number;
    attribution: "judge-only" | "confounded";
  } | null;
}

export interface AttemptResult {
  ok: boolean;
  failures: Failure[];
  toolNames?: string[];
  text?: string;
}

export interface ConvTurn {
  user: string;
  expect?: Record<string, unknown>;
}

export interface ResolvedLlmInputs {
  mode: "prompt" | "messages" | "conversation";
  /** name of the provider this case runs against, for error attribution */
  providerName?: string;
  system?: string;
  tools?: ToolDecl[];
  toolResponses: Record<string, unknown>;
  params: Record<string, any>;
  prompt?: string;
  messages?: ChatMessage[];
  conversation?: ConvTurn[];
}

export interface CaseResult {
  ok: boolean;
  failures: Failure[];
  skipped?: string;
  detail?: Record<string, unknown>;
  /** judge layer */
  score?: number;
  scale?: Scale;
  votes?: VoteResult[];
  agreement?: AgreementReport;
  /** the judges disagreed too much to trust the score — this is NOT a pass */
  inconclusive?: string;
  /** dispatch layer / block */
  dispatchState?: unknown;
  dispatchEffects?: unknown[];
  /** judge — observations for this run, appended by the runner (pass OR fail) */
  ledgerObservations?: Array<{ key: string; fp: string; obs: LedgerObservation }>;
  output?: string;
  /** exec layer failure context */
  outputTail?: string;
  /** static/compare — the multi-line structural report. Separate from `failures`
   *  because the console prints only 6 one-line failures and JUnit puts the
   *  summary in an attribute; the body goes here. */
  compareReport?: string;
  /** llm/judge — the exact inputs sent (triage snapshots these) */
  resolvedInputs?: ResolvedLlmInputs | null;
  attemptsDetail?: AttemptResult[];
}

export interface CaseCtx {
  layer: LayerConfig;
  providers: Record<string, Provider>;
  /** directory of the case's YAML file (or of heyllm.yaml for inline cases) */
  baseDir: string;
  lookup: (name: string) => unknown;
  saved: Record<string, unknown>;
  config: HeyLLMConfig;
  /** run-axis reliability history, loaded once per run by the runner */
  ledger?: LedgerFile;
}

export interface CaseRunRecord {
  name: string;
  tags: string[];
  file: string | null;
  durationMs: number;
  result: CaseResult;
  /** original YAML definition — triage re-runs from this */
  def: CaseDef;
  baseDir: string;
  /** tokens this case spent (absent if it made no model calls) */
  usage?: UsageTotals;
}

export interface LayerRunResult {
  name: string;
  kind: LayerKind;
  gate: boolean;
  ok: boolean;
  skipped?: string;
  durationMs: number;
  cases: CaseRunRecord[];
  /** tokens this layer spent (absent on layers that made no model calls) */
  usage?: UsageTotals;
}

export interface RunSummary {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  profile: string | null;
  layers: LayerRunResult[];
  /** layers not executed because a gated layer failed earlier (pyramid stop) */
  halted: string[];
  triage?: TriageReport[];
  /** A provider was unreachable/unauthorised, so part of the suite produced no
   *  verdict at all. Reported separately from `ok` because "we could not ask"
   *  is not "we asked and it was fine" — the CLI exits 2 (usage/config) on it
   *  even when every executed case passed.                                    */
  infra?: InfraProblem[];
  /** tokens the whole run spent, incl. triage (absent on a static-only run) */
  usage?: UsageTotals;
}

export interface InfraProblem {
  layer: string;
  case: string;
  provider?: string;
  message: string;
}

// ── triage (A/B probe) ────────────────────────────────────────────
export type TriageVerdict =
  | "flaky"
  | "your-change"
  | "model-drift"
  | "inconclusive"
  | "no-snapshot"
  | "config-changed";

export interface TriageArm {
  label: "current" | "snapshot";
  passed: number;
  attempts: number;
  failures: Failure[];
}

export interface TriageReport {
  layer: string;
  caseName: string;
  verdict: TriageVerdict;
  reason: string;
  arms?: TriageArm[];
  model?: { snapshot?: string; current?: string };
}

import type { LedgerFile, LedgerObservation } from "./ledger.js";

// ── baseline / snapshot store ─────────────────────────────────────
export interface SnapshotEntry {
  at: string;
  provider: string;
  model?: string;
  inputs: ResolvedLlmInputs;
  /** judge cases also snapshot their score */
  score?: number;
}

export interface BaselineFile {
  version: 1;
  scores: Record<string, { score: number; scale: Scale; at: string }>;
  snapshots: Record<string, SnapshotEntry>;
}
