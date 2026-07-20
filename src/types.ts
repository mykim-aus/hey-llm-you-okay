/**
 * Core shared types for Haechi.
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
  temperature?: number;
  maxTokens?: number;
  /** ask the provider for JSON-mode output when supported */
  json?: boolean;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
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
  /** gemini: merged into generationConfig verbatim (e.g. thinkingConfig) */
  generationConfig?: Record<string, unknown>;
  // command kind
  command?: string;
  args?: string[];
  outputPath?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export type LayerKind = "static" | "exec" | "http" | "llm" | "judge";

export interface Scale {
  min: number;
  max: number;
}

export interface JudgeParams {
  temperature?: number;
  maxTokens?: number;
}

export interface RubricItem {
  id: string;
  question: string;
  weight?: number;
}

/** A case is YAML-authored; `name` is the only universally required field. */
export type CaseDef = Record<string, any> & {
  name: string;
  tags?: string[];
  skip?: boolean;
};

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
  /** enable score-regression checks against the baseline file */
  baseline?: boolean;
  maxDrop?: number;
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
}

export interface HaechiConfig {
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
}

export interface VoteResult {
  weighted: number;
  scores: Record<string, number>;
  reasoning: string;
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
  output?: string;
  /** exec layer failure context */
  outputTail?: string;
  /** llm/judge — the exact inputs sent (triage snapshots these) */
  resolvedInputs?: ResolvedLlmInputs | null;
  attemptsDetail?: AttemptResult[];
}

export interface CaseCtx {
  layer: LayerConfig;
  providers: Record<string, Provider>;
  /** directory of the case's YAML file (or of haechi.yaml for inline cases) */
  baseDir: string;
  lookup: (name: string) => unknown;
  saved: Record<string, unknown>;
  config: HaechiConfig;
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
}

export interface LayerRunResult {
  name: string;
  kind: LayerKind;
  gate: boolean;
  ok: boolean;
  skipped?: string;
  durationMs: number;
  cases: CaseRunRecord[];
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
