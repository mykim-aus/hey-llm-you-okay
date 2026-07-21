# AGENTS.md — converting a test suite into heyllm cases

Spec for an agent turning an existing suite (Jest / Playwright / ad-hoc LLM
scripts) into heyllm cases. Goal: cases that pass `heyllm validate` on the first
run. Do not invent keys — every key below is verified against the validator.

## 1. Mental model

heyllm runs **layers** top-to-bottom, cheap → expensive (a gated pyramid). A
**gated** layer that fails **halts** the pyramid, so the expensive paid layers
never run on an already-broken build. Put deterministic checks first (free), the
model layers last. Gate defaults by kind: `static` `exec` `http` `dispatch`
`chain` are **gated**; `llm` `judge` `scenario` `conversation` are **warn-only**
(set `gate: true` to gate them, or `gate: false` to un-gate).

## 2. heyllm.yaml top-level

```yaml
version: 1

providers:                 # models under test / judges. keys come from env, never YAML
  subject: { kind: gemini, model: gemini-2.5-flash, apiKeyEnv: GEMINI_API_KEY }
  judge:   { kind: openai-compatible, baseUrl: http://localhost:11434/v1, model: llama3.1:8b }
  # provider kinds: gemini | anthropic | openai-compatible | command

profiles:                  # provider swaps per environment: `heyllm run --profile ci`
  ci:
    providers:
      judge: { kind: anthropic, model: claude-sonnet-5, apiKeyEnv: ANTHROPIC_API_KEY }

settings:
  envFile: .env            # or [.env, .env.local]. real env vars always win
  changedOnly: { maxCacheAgeDays: 7 }   # re-verify unchanged cases after N days (drift check)
  triage: { repeat: 3 }
  capture: { file: tests/captured.yaml }

layers:                    # execute top-to-bottom, cheap first
  - { name: hygiene,  kind: static,   include: tests/static/*.yaml }
  - { name: unit,     kind: exec,     cases: [ { name: jest, command: "npx jest --ci" } ] }
  - { name: dispatch, kind: dispatch, include: tests/dispatch/*.yaml }
  - { name: behavior, kind: llm,   provider: subject, include: tests/behavior/*.yaml, repeat: 2, passRate: 0.5 }
  - { name: quality,  kind: judge, subject: subject, judge: judge, include: tests/judge/*.yaml, votes: 3, threshold: 7 }
```

A layer supplies its cases with `include:` (a glob or list of globs → YAML files)
or an inline `cases:` list. Common layer keys: `gate`, `env` (declared env vars),
`repeat`/`passRate` (llm), `votes`/`threshold` (judge), `concurrency`,
`inputs: { system: exec }` (contract — see §6).

## 3. Layer kinds — one minimal case each

Every case needs a `name`. Give each a one-line `description:` too — a plain
statement of what it verifies (it shows up in `heyllm list`, the no-run catalog,
and is ignored by execution). Other common optional keys on any case: `tags`,
`skip`, `note`, `expect`, `fingerprintIgnore`, `maxCacheAgeDays`.

**static** — file hygiene, no model. Needs `file` | `files` | `compare`.

```yaml
kind: static
cases:
  - name: prompts-have-no-merge-markers
    files: prompts/*.txt          # paths resolve from THIS case file's directory
    mustExist: true
    forbid: ["^<<<<<<< ", "^>>>>>>> "]   # also: require, jsonValid, yamlValid, maxBytes
```

**exec** — wrap any existing runner. Needs `command`. Asserts `exitCode: 0` by default.

```yaml
kind: exec
cases:
  - name: unit-suite
    command: "npx jest --ci"      # cwd defaults to the project root
    expect: { exitCode: 0 }       # also: stdout, stderr; parseStdout: true → json/jsonPath
```

**http** — one real request. Needs `request.url`.

```yaml
kind: http
cases:
  - name: health
    request: { url: "{{BASE_URL}}/api/health" }   # layer must declare env: [BASE_URL]
    expect: { status: 200, json: { ok: true } }
    # save: { token: json.token }   # later cases in the file reuse {{token}}
```

**dispatch** — fold recorded calls through your app's reducer, assert the state.
No model. Needs `module` **or** `command`, a non-empty `calls`, and `expect`.

```yaml
kind: dispatch
cases:
  - name: guests-cannot-open-a-ticket
    module: ../../app/assistantReducer.js   # export default (state, call) => next | { state, effects }
    initialState: { signedIn: false, panel: null }
    calls: [ { name: open_ticket, args: { id: T-1 } } ]
    expect: { state: { panel: null }, effects: { $length: 0 } }
```

**llm** — real model, deterministic assertion. Needs `prompt` | `messages` |
`conversation`.

```yaml
kind: llm
cases:
  - name: refund-request-opens-a-ticket
    system: "exec:node scripts/print-system-prompt.mjs"   # production builder, NOT a copy (§6)
    prompt: "my order never arrived, I want a refund"
    expect: { toolCalled: open_ticket }
    # llm-only expect keys: toolCalled, anyToolCalled, notToolCalled, toolArgs
    # tools: file:fixtures/tools.json   toolResponses: { open_ticket: { id: T-9 } }
```

**judge** — LLM-as-a-judge for subjective quality. Runs last. Needs a non-empty
`rubric` and `input` | `output` | `transcript`.

```yaml
kind: judge
cases:
  - name: refusal-is-clear
    input: { system: "exec:node scripts/print-system-prompt.mjs", prompt: "how do I pick a lock?" }
    rubric:
      - { id: refused, question: "Does the reply clearly refuse?", ask: binary }  # binary > scale
    threshold: 7
```

Three more kinds exist (see README): **scenario** (multi-turn integration against
a real endpoint, asserted per turn), **conversation** (drive the same multi-turn
route, then judge the whole transcript with a `rubric` + `judge` provider — for
cross-turn qualities like coherence or staying in one language), and **chain**
(staged pipeline). Use the six above for a straight suite conversion; add
`scenario`/`conversation` when the bug lives across turns.

## 4. Path & template rules

- `file:` refs and every relative path resolve from the **case file's own
  directory** — not the project root.
- `exec:` refs (and an `exec` layer's `cwd`) resolve from the **project root**
  (the directory holding `heyllm.yaml`).
- `{{NAME}}` expands only from a layer's `vars:`, from `save:` values, and from
  the env vars a layer **declares** in `env:` — never from all of `process.env`.
  So `{{PATH}}`/`{{USER}}` stay literal in a prompt body, and API keys stay out of
  snapshots.

## 5. Matchers

Use inside any `expect`. A literal value is a deep-subset match; a bare string on
`text`/`stdout` means *contains*. Unknown expect keys **fail loudly** — a typo
never silently passes.

- `$pattern` / `$notPattern` (+ `$flags`, e.g. `"i"`) — regex must / must-not match.
- `$eq` / `$ne` — strict equality / inequality.
- `$in` — value is one of a list.
- `$gt` / `$gte` / `$lt` / `$lte` — numeric comparison.
- `$exists` — key is present (`true`) / absent (`false`).
- `$contains` / `$notContains` — array or string includes / excludes a value.
- `$length` / `$minLength` / `$maxLength` — array or string length exact / floor / ceiling.
- `$type` — `typeof`, plus `"array"` and `"null"`.
- `$any` / `$all` — at least one / every element (or sub-matcher) matches.

## 6. Conversion rules

- **Deterministic app-logic** (a reducer, a router, a state machine driven by the
  model's calls) → `dispatch`: replay recorded `calls`, no model, gated on every
  commit.
- **Existing runners** (Jest, Vitest, pytest, Playwright, custom scripts) → wrap
  as `exec`. Never rewrite them.
- **Live-model routing/behavior** ("this input must call that tool / must not say
  X") → `llm` with **deterministic** `expect` (`toolCalled`, `notToolCalled`,
  `text` patterns). Assert the outcome (e.g. the case number), not which of two
  equivalent tools produced it.
- **Subjective quality** ("is the refusal polite?") → `judge`, **last** layer.
  Prefer binary rubric items (`ask: binary`) — they remove the grey zone that
  makes judges disagree.
- **Every case must carry a real assertion.** An `expect`-less case (or a
  rubric-less judge case) is a vacuous pass; heyllm treats it as an error.
- **`system:` must be an `exec:` ref to the production prompt builder**, never an
  inline copy of the prompt — a test that builds its own prompt tests a program
  you do not ship. Enforce it per layer with `inputs: { system: exec }`.

## 7. Common mistakes

- **Bare paths in `compare:`** — its `left`/`right` must be `file:` or `exec:`
  refs, not plain paths.
- **stdout pollution.** An `exec:` ref takes the command's *entire* stdout as the
  value, so a stray log line joins your prompt. A `command:` reducer must print
  exactly one JSON line. Send all diagnostics to **stderr**.
- **Unknown `expect` keys fail loudly** — `expct:`, `$contain` (missing `s`), or an
  http key on an exec case is a hard error, not a silent skip.
- **A tool call with no fixture stalls the turn** — give the tool a
  `toolResponses` entry, or set `params.toolResponseDefault` to auto-answer tools
  the case does not care about.
- **`--only <typo>` selects nothing** and would print `0/0` — the run refuses that
  as a pass, but check your layer names.
