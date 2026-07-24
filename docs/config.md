# Config reference — `heyllm.yaml`, matchers, and the prompt-regression workflow

See also: [layers.md](layers.md) for each layer kind · [cli.md](cli.md) for commands and CI ·
[AGENTS.md](../AGENTS.md) for the condensed, agent-facing spec.

## The full config

```yaml
version: 1

providers:
  subject:                          # the model under test
    kind: gemini                    # gemini | anthropic | openai-compatible | command
    model: gemini-2.5-flash
    apiKeyEnv: GEMINI_API_KEY       # keys come from env — never from YAML
  judge:                            # the evaluator — can be a totally different provider
    kind: openai-compatible
    baseUrl: http://localhost:11434/v1   # Ollama: local, free, private
    model: llama3.1:8b
    # omitTemperature: true         # models that reject sampling params (o-series,
    # maxTokensParam: max_completion_tokens   # newest Claude) are auto-detected;
                                    # these override the detection if needed

profiles:                           # swap providers per environment
  ci:                               # → heyllm run --profile ci  (or HEYLLM_PROFILE=ci)
    providers:
      judge: { kind: anthropic, baseUrl: null, model: claude-sonnet-5, apiKeyEnv: ANTHROPIC_API_KEY }

settings:
  triage: { repeat: 3 }             # A/B probe attempts per arm
  capture: { file: tests/captured.yaml }

layers:                             # ← executes top-to-bottom: CHEAP FIRST
  - name: static                    # ① typos, forbidden patterns, prompt sanity (ms, free)
    kind: static
    include: tests/static/*.yaml

  - name: unit                      # ② your EXISTING runners, wrapped — not replaced
    kind: exec
    cases:
      - { name: jest, command: "npx jest --ci", cwd: ".." }

  - name: api                       # ③ HTTP integration: auth, quotas, error paths
    kind: http
    include: tests/http/*.yaml
    env: [BASE_URL]                 # missing env → gated layer fails loudly

  - name: behavior                  # ④ real model, deterministic assertions
    kind: llm
    provider: subject
    include: [tests/behavior/*.yaml, tests/captured.yaml]
    repeat: 2                       # flaky control: N attempts,
    passRate: 0.5                   # pass if ≥ ratio succeed

  - name: quality                   # ⑤ LLM-as-a-judge — most expensive, runs last
    kind: judge
    subject: subject
    judge: judge
    include: tests/judge/*.yaml
    votes: 3                        # median of 3 judge votes
    threshold: 7
```

> **Path rule.** Every relative path and `file:` ref resolves against the **case file's own
> directory**, not the project root. With the layout above, a case in `tests/behavior/x.yaml` writes
> `file:../../prompts/…`, while one in `tests/captured.yaml` writes `file:../prompts/…`. Only `exec:`
> refs and `exec` layer `cwd:` resolve from the project root (where `heyllm.yaml` lives).
>
> **Template rule.** `{{NAME}}` expands from a layer's `vars:`, from `save:` values, and from the env
> vars a layer **declares** in `env:` — never from all of `process.env`. That keeps `{{USER}}`/`{{PATH}}`
> in a prompt body literal and keeps API keys out of the committed snapshot.

## Matchers

`$pattern` `$notPattern` (+`$flags`) · `$eq` `$ne` `$in` · `$gt` `$gte` `$lt` `$lte` · `$exists` ·
`$contains` `$notContains` · `$length` `$minLength` `$maxLength` · `$type` · `$any` `$all`. Literal
objects are deep subsets; bare strings on `text`/`stdout` mean *contains*. Unknown expect keys **fail
loudly** — a typo never silently passes.

**Every tool call must be answered.** If the model calls a tool with no fixture, the turn stalls
waiting for a response — heyllm says so by name instead of reporting a blank reply. Give it a fixture,
or set `params.toolResponseDefault` to auto-answer the tools your case doesn't care about.

## Prompts that are built by code (`exec:` refs)

Real prompts are often assembled at runtime — a builder function, DB-loaded persona, retrieved
context — not stored as a flat file. `exec:` runs a command and uses its **stdout** as the value, with
`cwd` = the project root (where `heyllm.yaml` lives):

```yaml
system: "exec:node scripts/print-system-prompt.mjs hidden"
tools:  "exec:node scripts/print-tool-declarations.mjs"
```

Output is memoized per process (repeat/votes/triage arms reuse it), and triage snapshots store the
**resolved** text — so code-built prompts still get full A/B drift detection.

> **stdout is the value; send everything else to stderr.** An `exec:` ref takes the command's *entire*
> stdout as the resolved text, so a stray log line becomes part of your prompt. This bites hardest with
> frameworks that print a banner on import — a Python server that logs `[app] loaded 95 keys` at startup
> will silently prepend that to your system prompt. Route diagnostics to stderr
> (`print(..., file=sys.stderr)`, `console.error`), or wrap the noisy import:
> `with contextlib.redirect_stdout(sys.stderr): import app`.
>
> If your script ends with `process.exit()`, flush first —
> `process.stdout.write(data, () => process.exit(0))`. A bare `process.exit()` truncates piped output.

## Config: keys without manual exports

```yaml
settings:
  envFile: .env        # or [.env, .env.local]
```

Loaded before the run; **real environment variables always win**, so CI secrets are never shadowed by
a stale local `.env`.

## The core workflow: prompt regression

Your prompts are `file:` (or `exec:`) refs. That means **every prompt edit is a change heyllm can
see**:

```bash
vim prompts/chatbot.txt        # ← the risky change
heyllm run                     # every scenario re-validated against the new prompt
heyllm triage                  # red? find out WHO broke it
heyllm run --update-baseline   # green? freeze the new prompt as the snapshot
```

Commit `.heyllm/baseline.json` with the prompt change — the snapshot and the prompt travel together
through code review. Do **not** commit `.heyllm/ledger.json` or `.heyllm/prompts.json`: they are
per-run logs that would conflict on every branch (`heyllm init` gitignores them for you).

> **Known trade-off.** The baseline stores the *resolved* prompt per case, so two branches that both
> edit prompts will both regenerate it and can conflict on `baseline.json`. It is committed on purpose —
> triage's A/B arm needs the last-passing input to exist — but the conflict blast radius is a real
> operational cost. If it bites, regenerate the baseline on the merge target after merging rather than
> resolving the JSON by hand.

### `--changed-only`: only pay for what actually changed

On a big suite most commits touch one prompt. `--changed-only` fingerprints the *exact resolved
payload* of every llm/judge case (system + turns + tools + params + model — a rename of a tool
description counts, a file-diff would miss it) and, for a case whose payload is unchanged, **replays
its last passing output through the assertions instead of calling the model again**:

```
▸ behavior 7/7 (7 cached) 3.6s          # was 20s and 320k tokens; now 0 tokens
  ✓ s1-driving-sets-screen-hidden ⋯cached (input unchanged since … — no model call)
  ...
```

A cached result is a **real ✓/✗** — the assertions genuinely ran against a real prior output for an
identical input — but it is marked `⋯cached` and counted separately, never dressed up as a fresh live
pass. Editing only the `expect:` (not the prompt) re-checks the *new* assertion against the cached
output for free. A case with no cached output yet, or a `dispatch` fold that can't be replayed from
text, falls back to a plain skip. The cache always stores a **passing** attempt's output, so under
`passRate < 1` the replay verdict matches the live one.

`exec` cases can join the same contract with a `fingerprint:` probe command — a wrapped harness
builds its payload inside the child process where heyllm cannot see it, so the case declares a cheap
command that prints those inputs and the hash of its output decides run-vs-skip. See
[layers.md → exec](layers.md#exec--wrap-anything).

When a case re-runs under `--changed-only` even though you did not edit it, heyllm says why:

```
  ✓ roleplay-scene ↻ payload changed since … — if you did not edit it, the inputs are
      non-deterministic (random/timestamped content); add fingerprintIgnore …
```

### `fingerprintIgnore`: the parts that are *meant* to vary

A production prompt often carries per-run content that is not a code change — sampled review words, a
"recent session" recap, a timestamp. Left in, the fingerprint moves every run and `--changed-only`
(and triage's byte-identical fast-path) can never treat the case as unchanged. Blank those regions
from the fingerprint only — the model still receives the full prompt:

```yaml
- name: behavior
  kind: llm
  provider: subject
  fingerprintIgnore:
    - "^DUE FOR REVIEW: .*$"      # line-anchored patterns are multiline (^/$ = line, not string)
    - "\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z"
```

The same ignore list feeds triage, so a case you made stable for `--changed-only` also takes triage's
zero-cost byte-identical path. Ignore the *data*, never the instructions around it: a real change
confined to an ignored region will not be detected.

### `maxCacheAgeDays`: re-verify on a cadence to catch provider drift

Caching a result forever has a failure mode: your input never changed, but the **provider quietly
updated the model**, and you would keep replaying a stale pass that no longer reflects reality.
`maxCacheAgeDays` closes that — past the limit, an unchanged case is re-run against the live model
instead of replayed:

```yaml
settings:
  changedOnly:
    maxCacheAgeDays: 7        # anything cached longer than a week is re-verified
layers:
  - name: behavior
    kind: llm
    provider: subject
    maxCacheAgeDays: 1         # per-layer override: re-check this one daily
```

So `--changed-only` gives you the cheap path day to day, and `maxCacheAgeDays` turns it into a
**scheduled drift probe**: run it nightly and a provider-side change surfaces within the window as a
real failure, not a stale green. Unset means the cache never expires on age.

## Testing what you actually ship

`heyllm validate` reports where every llm/judge case's system prompt comes from:

```
✓ layer routing (llm) — 6 cases · system: 6 absent
✓ layer behavior (llm) — 12 cases · system: 10 exec, 2 inline
```

`6 absent` on a routing layer is the whole finding: those cases send no system prompt at all while
production assembles a large one. This is a census, never a verdict — no threshold, no colour, exit
code untouched — so it cannot become noise you learn to ignore.

To make it enforceable, a layer can declare what its cases must send:

```yaml
- name: routing
  kind: llm
  provider: subject
  inputs:
    system: exec          # required | file | exec
```

`exec` means the prompt must come from an `exec:` ref — your real builder, the code production runs.
Checked at **validate** time on the ref form (before a token is spent) and again at **run** time.
Layer-level on purpose: the contract is a claim about the suite, so no single case can quietly exempt
itself.

One rule needs no opt-in: a `file:`/`exec:` system ref that **resolves to zero bytes** always fails.
There is no legitimate reading of "I asked this ref for a prompt and got nothing."

## Local LLM ↔ CD API keys

The same suite runs against a **local model on your machine** and **API providers in CD** — only the
profile changes:

```bash
heyllm run                      # default: Ollama at localhost — free, private
heyllm run --profile ci         # CD: Gemini subject + Claude judge via env keys
```

You can even use your **local Claude Code CLI as the judge** (no API wiring at all):

```yaml
providers:
  judge:
    kind: command
    command: claude
    args: ["-p", "--output-format", "json"]
    outputPath: result
```

A `command` provider has no tool-call protocol, so it suits `judge` layers and text-only `llm` cases.
Point a case with `tools:` at one and it fails immediately naming the provider.

**Paid layers, opt-in.** A layer may reference a provider that only a profile defines. Without that
profile the layer fails loudly (exit 2) instead of being skipped, so a cheap default run and an
expensive CI run can live in one config:

```yaml
providers:
  judge: { kind: command, command: claude, args: ["-p"], outputPath: result }
profiles:
  live:
    providers:
      subject: { kind: anthropic, model: claude-sonnet-5, apiKeyEnv: ANTHROPIC_API_KEY }
layers:
  - { name: quality, kind: judge, subject: judge, judge: judge, include: tests/judge/*.yaml }
  - { name: routing, kind: llm, provider: subject, include: tests/routing/*.yaml }  # needs --profile live
```
