# hey llm, you okay?

> A team had **96 test files, all green**. The prompt those tests checked was one their
> production server had never sent. The suite was faithfully testing a program they did not ship.

**heyllm** is a single-YAML LLM testing CLI built around one question: **when a test is green, was
anything actually verified — and when it's red, whose fault is it, yours or the provider's?**

It didn't start as a library. It was the pre-deploy gate inside **smoveth**, my live
English-learning app (a hands-free voice tutor over Gemini Live — 14 languages, 16 tools, replies
*routed* through a real RAG → DB → UI chain). That pipeline ran before every deploy. This repo is
that pipeline, lifted out and open-sourced. Most numbers here are its real findings — not a toy
fixture. → [Why it exists](docs/why.md) · [the two-day case study](CASE-STUDY.md)

## Watch a green turn out to be a lie — in 60 seconds

No API keys. A mock provider plays the model, and mid-run it *silently changes its behaviour* —
exactly what a provider does when it ships a new model version over a weekend.

```bash
git clone https://github.com/mykim-aus/hey-llm-you-okay && cd hey-llm-you-okay
npm install
npm run demo
```

What you watch happen:

```
STEP 1 — green pyramid run, snapshots recorded (--update-baseline)
  ▸ static    2/2 ✓        ← ms, free
  ▸ api       3/3 ✓        ← HTTP integration, deterministic
  ▸ behavior  5/5 ✓        ← real model, deterministic asserts
  ▸ quality   5/5 ✓        ← LLM-as-a-judge
  ALL GREEN. The last-passing inputs are now frozen as a snapshot.

STEP 2 — the provider "updates its model over the weekend" (drift ON)
  (mock: the chatbot silently loses multi-turn context)

STEP 3 — heyllm triage: is it OUR prompt, or THEIR model?

  ▸ behavior  4/5 ✗
  ▸ halted    quality       ← pyramid stopped: no tokens burned on a red build

  ◆ TRIAGE — AI failure adjudication (A/B probe)
    MODEL-DRIFT  behavior/coffee-order-keeps-context   (confidence: medium)
        inputs are byte-identical to the last-passing snapshot yet now fail 3/3 —
        nothing on your side changed; the provider's model behaviour did
```

That's the whole pitch. The test *was* green. Nothing in your repo changed. heyllm re-ran the
failing case against **both today's inputs and the last-passing snapshot**, saw the byte-identical
inputs now fail, and told you the cause — `MODEL-DRIFT`, not `YOUR-CHANGE` — instead of leaving you
to guess at 2am. Every verdict carries a **confidence**, because an n=3 guess must never be dressed
as a certainty.

## The one rule it will not break

**A green that verified nothing is a bug — and heyllm refuses to print one.**

- A **skipped** case is not a pass.
- An **assertion-less** case is not a pass — it iterated zero expectations.
- A provider you **could not reach** is not a pass (`◆ NOT VERIFIED`, exit 2).
- A `system:` ref that resolved to **zero bytes** ran no prompt, so it fails.
- And a suite can *assert* that the prompt it tests is the one **production actually sends** — the
  exact gap behind the opening story.

Everything else — the cost-ordered pyramid, the fault attribution, the judge-reliability ledger — is
downstream of that one rule. → [the five things that fall out of it](docs/why.md)

## Install & first run

```bash
npm i -D hey-llm-you-okay        # the package name…
npx heyllm init                  # …installs a `heyllm` command
npx heyllm validate              # lint config & cases without spending a token
npx heyllm run                   # run the pyramid
```

> The npm package is **`hey-llm-you-okay`**; the CLI it installs is **`heyllm`**. Install by the long
> name once, then it's `heyllm` (or `npx heyllm`) everywhere.

## When it's red, whose fault is it?

A failing LLM test has three causes needing three different actions. `heyllm triage` A/B-probes your
current inputs against the last-passing snapshot under today's model and tells you which:

| verdict | meaning | what you do |
|---|---|---|
| `FLAKY` | isolated re-run passes — sampling noise | tune `repeat`/`passRate`, not code |
| `YOUR-CHANGE` | last-passing inputs still work today; yours don't | fix your diff |
| `MODEL-DRIFT` | even the last-passing inputs now fail | the provider changed the model — re-baseline or adapt |

Byte-identical inputs skip the second arm — `MODEL-DRIFT` at zero extra cost. → [more](docs/why.md)

## The pyramid — layers, cheap → expensive

Layers run top-to-bottom. A failing **gated** (deterministic) layer halts the run, so no tokens burn
on a build whose unit tests are already red. Your existing Jest/pytest/Playwright suites get
**wrapped** (`exec`), not rewritten.

| layer | what it checks | gated? |
|---|---|:--:|
| `static` | prompt-file typos, forbidden patterns, `compare:` (test prompt == prod prompt) | ✓ |
| `exec` | wrap any runner — Jest, pytest, Playwright, a custom script | ✓ |
| `http` | one real request: auth, quotas, error paths, save-chaining | ✓ |
| `dispatch` | fold the model's calls through **your** reducer, assert the app STATE | ✓ |
| `scenario` | drive a real multi-turn endpoint, assert each turn | — |
| `conversation` | drive the multi-turn route, then judge the whole transcript | — |
| `llm` | real model, **deterministic** asserts (`toolCalled`, `text` patterns, JSON shape) | — |
| `judge` | LLM-as-a-judge for subjective quality, with a run-axis reliability ledger | — |
| `chain` | attribute WHICH stage of a deep pipeline decided wrong | ✓ |

Full reference with a minimal case for each → **[docs/layers.md](docs/layers.md)**.

## Config in 60 seconds

```yaml
version: 1
providers:
  subject: { kind: gemini, model: gemini-2.5-flash, apiKeyEnv: GEMINI_API_KEY }  # keys from env, never YAML
  judge:   { kind: openai-compatible, baseUrl: http://localhost:11434/v1, model: llama3.1:8b }
layers:                              # executes top-to-bottom: CHEAP FIRST
  - { name: static,   kind: static, include: tests/static/*.yaml }
  - { name: unit,     kind: exec,   cases: [ { name: jest, command: "npx jest --ci", cwd: ".." } ] }
  - { name: behavior, kind: llm,    provider: subject, include: tests/behavior/*.yaml, repeat: 2, passRate: 0.5 }
  - { name: quality,  kind: judge,  subject: subject, judge: judge, include: tests/judge/*.yaml, votes: 3, threshold: 7 }
```

`profiles:` swap providers per environment (local Ollama by default, cloud in CI). Prompts are
`file:`/`exec:` refs, so every prompt edit is a change heyllm can see — and `--changed-only` replays
the unchanged cases from cache at zero tokens. Full config reference, matchers, and the
prompt-regression workflow → **[docs/config.md](docs/config.md)**.

## Migrating an existing suite with an AI agent

heyllm ships an agent-facing spec, **[AGENTS.md](AGENTS.md)** — a condensed, validator-checked
reference (every key verified). Point a coding agent at *that file, not this README*:

> Read AGENTS.md in this repo, then convert the tests under `tests/` into heyllm cases and a
> `heyllm.yaml`. Wrap the existing runners (Jest/pytest/Playwright) as `exec` layers — do not rewrite
> them. File/prompt hygiene → `static`; deterministic app-logic → `dispatch`; live-model
> routing/behavior → `llm` with deterministic `expect`; subjective quality → `judge`, last, with
> binary rubric items. Every case must carry a real assertion. Every `system:` must be an `exec:` ref
> to the production prompt builder — never an inline copy. Then run `heyllm validate` and fix what it
> reports.

An AI-generated suite fails in one predictable way: plausible cases that verify nothing. heyllm is
built to refuse exactly that green — so validate first (it spends zero tokens), then read the cases it
produced. It catches the vacuous ones; only you know which behaviors matter. (I migrated smoveth's own
suite this way.)

## Docs

- **[docs/why.md](docs/why.md)** — the reasoning, the comparison with promptfoo / DeepEval, the router story
- **[docs/layers.md](docs/layers.md)** — every layer kind, with a minimal case each
- **[docs/config.md](docs/config.md)** — `heyllm.yaml`, matchers, `--changed-only`, `exec:` refs, testing the prompt you ship
- **[docs/cli.md](docs/cli.md)** — CLI, the `pipelines` dashboard, CI/CD, cost, `doctor`, bulk `ingest`, programmatic API
- **[CASE-STUDY.md](CASE-STUDY.md)** — the two-day story that produced the tool

## License

MIT
