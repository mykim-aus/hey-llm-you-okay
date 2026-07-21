# Why heyllm — the long version

The [README](../README.md) makes one promise: **never report a green that verified nothing.**
This page is the reasoning behind it, the five things that fall out of it, and an honest
comparison with the tools it sits next to.

heyllm did not start as a library. It was the pre-deploy pipeline inside **smoveth**, my
live English-learning app — a hands-free voice tutor over Gemini Live, 14 languages, 16
tools, on a Next.js backend where the model's replies are *routed* through a real
RAG → DB → UI-reducer chain. The pipeline ran before every deploy. This repo is that
pipeline, lifted out and generalized. The opening story, the [case study](../CASE-STUDY.md),
and most numbers here are its actual findings there — not a toy fixture.

## The five things that fall out of the one rule

**1. A green that verified nothing is a bug — and heyllm refuses to print one.** This is the
spine everything else hangs off. A skipped case is not a pass. An assertion-less case is not
a pass. A provider you could not reach is not a pass (`◆ NOT VERIFIED`, exit 2). A case whose
`system:` ref resolved to zero bytes ran no prompt, so it fails. And a suite can *assert* that
the prompt it tests is the one production assembles — the exact gap behind the opening story.
The pyramid mechanics are downstream of this: layers run cheap → expensive, a failing **gated**
layer halts the run so no tokens burn on a build whose unit tests are already red, and your
existing Jest/pytest/Playwright suites are **wrapped** (`exec`), not rewritten.

**2. When it's red, it tells you whose fault it is — with a confidence.** A failing LLM test
has three different causes needing three different actions:

| verdict | meaning | what you do |
|---|---|---|
| `FLAKY` | isolated re-run passes — sampling noise | tune `repeat`/`passRate`, not code |
| `YOUR-CHANGE` | last-passing inputs still work today; yours don't | fix your diff |
| `MODEL-DRIFT` | even the last-passing inputs now fail | provider changed the model — re-baseline or adapt |

`heyllm triage` A/B-probes **current inputs vs. the last-passing snapshot** under today's
model. Byte-identical inputs skip the B-arm — `MODEL-DRIFT` at zero extra cost. Crucially,
**the verdict is not stated with more certainty than the sample supports**: a call from
`repeat: 3` is labelled `confidence: medium` and asks you to raise `repeat` before acting, so
an attribution tool never mis-attributes with a straight face. (That is the same statistical
humility heyllm demands of the judge below — held to itself.)

**3. It tells you when the judge cannot be trusted — on the axis where it actually breaks.**
Measured on a real case: the same rubric item scored **(9,8) then (2,3) then (10,9)** across
three runs. Agreement *within* each run was perfect, so a vote-spread check calls all three
"stable" — and the middle run's tight agreement stamps confidence on a verdict 6 points off.
The instability is on the **time** axis, and more votes cannot see it. heyllm keeps a run-axis
ledger and returns **INCONCLUSIVE** when scores swing across runs — with attribution: an
identical output hash means the *judge* moved, so the fix is a decision rule, not more samples.

**4. The chain does not end at the model — and when it has many stages, heyllm says WHICH one
decided wrong.** Asserting the tool call is table stakes — promptfoo, DeepEval and the agent
frameworks all do it. Real bugs live one step later: the model calls the right tool and the app
still does nothing. A `dispatch` block folds the model's calls through **your** reducer and
asserts the state a user would actually have reached — the panel that opened, the row that was
written, the destructive query that was *refused*. It also runs standalone on **recorded**
calls, so "model was right, app did nothing" is a free, deterministic gate.

A real app has *more* than one hop: the model emits a vague argument → a retriever grounds it
to the wrong record → the UI shows it. The stage that *surfaces* the bad output is usually not
the stage that *decided* wrong, and asking an LLM judge to read the trace and guess is ~14%
accurate at the step level ([Who&When](https://ag2ai.github.io/Agents_Failure_Attribution/)).
A `chain` layer runs the input through your **ordered, real-backend stages** and, on a red
result, does a deterministic counterfactual: force one stage's output to its declared `golden`,
re-run everything downstream *for real*, and report the smallest stage whose fix recovers the
outcome — the decision point, not the symptom. This is
[Causal Agent Replay](https://arxiv.org/abs/2606.08275) (record the one nondeterministic input,
re-execute the deterministic glue) made into a first-class layer. The honest bounds: it needs
your downstream stages to be deterministic and a `golden` per stage, and it earns its keep on
deep chains — on a two-hop chain a 30-line probe does the same. It is not magic on stochastic
middle hops; it is the productization of a published method.

**5. Every production complaint becomes a permanent test.** `heyllm capture "…"` promotes one;
`heyllm ingest export.jsonl` bulk-imports a whole feedback export — with provenance, dedup, and
skip-until-reviewed so 275 imported rows can't become 275 vacuous passes. See
[cli.md → Growing the corpus](cli.md#growing-the-corpus-in-bulk).

## Does it find real bugs? And does it hold *itself* to this bar?

The app it was built against — **smoveth** — had **96 green test files** and still shipped three
bugs in a day: a suite testing a prompt production never sent, an app that suppressed a visual
then told the model it hadn't, and a whole conversation mode answering in the wrong language
across 13 locales. Every one was invisible for the same reason — the tests were pointed at the
wrong artifact — and that is exactly the class of failure heyllm is built to make visible. The
[case study](../CASE-STUDY.md) walks through all three. Later it caught a fourth: a grammar
question that grounded to the wrong lesson because the model passed a made-up sentence a
retriever then mis-matched — the kind of *which-stage-decided-wrong* bug the `chain` layer now
attributes automatically.

An eval tool that is itself flaky is worth less than nothing, so heyllm is held to its own bar.
It **tests itself** (`heyllm run` gates its own build), ships an offline end-to-end demo, and was
put through an **adversarial audit that found six of its own silent-green paths** — a triage
verdict stated too confidently, a probe that ignored a reducer's exit code, a metering rollup
that double-counted a string — each fixed with a regression before release.

Concretely, on the codebase itself: **86% statement / 74% branch coverage** across 160+ tests.
The honest part is *where* the gap is — it is almost entirely the **reporters and CLI wiring**
(the JUnit/JSON writers, argument plumbing, colour output), not the verdict logic. The engine
that decides pass/fail/inconclusive/drift is the most-covered layer; what is thinner is the code
that *prints* those decisions. That is the right place for the gap to be, but it is a gap.

## How it compares

**[promptfoo](https://www.promptfoo.dev)** and **[DeepEval](https://deepeval.com)** are
excellent, and heyllm holds its own next to them: **LLM-as-a-judge, tool-call assertions,
multi-provider, CI exit codes, and token reporting are ✓ for all three**. The table below skips
that shared ground and shows only where the three *differ* — the ground heyllm was built to
cover: a test suite as a cost-ordered pipeline that **attributes** a failure instead of just
reporting it.

| where they differ | heyllm | promptfoo | DeepEval |
|---|:--:|:--:|:--:|
| Config format | YAML | YAML | Python |
| Dollar cost estimate | ✗ *by design*¹ | ✓ | partial |
| **Wraps your existing jest/pytest/playwright suites** as a gated stage | ✓ `exec` | reverse only² | pytest-only³ |
| **Cheap deterministic checks gate the expensive model calls** | ✓ gated pyramid | ✗ | ✗ |
| **Attributes a red test — your prompt vs the provider's drift**, with a confidence | ✓ `triage` | manual | manual |
| **Judge reliability *across runs* → INCONCLUSIVE** (not just vote-spread in one run) | ✓ ledger | ✗ | ✗ |
| **Asserts your APP's state** after folding tool calls through your reducer | ✓ `dispatch` | custom hook⁴ | custom metric⁴ |
| **Attributes WHICH stage of a real-backend chain decided wrong** — deterministic counterfactual, not an LLM-judge guess | ✓ `chain`⁷ | ✗ | manual patch-rerun |
| **Asserts the test prompt is the one production sends** | ✓ `compare` / `inputs` | ✗ | ✗ |
| Bulk-ingest a production-feedback export → reviewable regression stubs | ✓ `ingest`⁵ | ✗ | generic JSONL⁶ |

<sub>¹ heyllm reports tokens but ships no price table — a vendored price is stale the day after,
and `openai-compatible` covers zero-cost local models. ² promptfoo's Jest integration runs the
*other* way: you call promptfoo matchers inside Jest, not your suite inside promptfoo. ³ DeepEval
*is* pytest (Python only) — it co-runs your Python asserts, not jest/playwright. ⁴ reachable only
via a custom JS/Python assertion you write yourself. ⁵ with provenance, dedup, and
skip-until-reviewed so a 275-row import can't become 275 vacuous passes. ⁶ DeepEval natively loads
JSONL into goldens, but has no feedback-specific ingestion. ⁷ deterministic downstream stages + a
`golden` per stage required; earns its keep on deep chains, not two-hop ones — see point 4.</sub>

What ties these together is one principle the whole tool is built to enforce: **never report a
green that verified nothing.** That is the reason to reach for heyllm — the table is about
capability shape, not a scoreboard.

## When the model's reply is your router

Some products aren't chatbots: the model's reply *is* the router. The reply decides which mode
the user lands in — speaking, listening, a PTE drill, a dictation-mode UI — and the text is almost
incidental. The routing is the product, and a misroute is the bug. This is smoveth's shape, and
it is why the pipeline exists.

The honest starting point is Jest + Playwright, and both do real work: a mocked-model Jest unit
genuinely asserts a branch, and a Playwright run genuinely drives the mode into the DOM. Where
they stopped scaling for prompt work:

- A mocked model froze the routing at mock-authoring time: retune the prompt and the mock stays
  green while the live model starts routing differently — green test, broken prod.
- The real-UI Playwright run needed real login/auth and was flaky on streaming, a delayed
  auto-send, and WebSocket latency — a pre-release smoke check, not something to run on every
  prompt tweak.
- Real-model tests cost money and are nondeterministic, so re-running the whole suite on every
  prompt edit wasn't viable.
- On red, neither tool attributed fault: your prompt edit vs. the provider quietly changing the model.
- The tests lived in three places — Jest units, Playwright E2E, ad-hoc LLM scripts — with no
  single ordered pipeline.

Four daily questions, each mapped to a heyllm layer:

| The question | The layer |
|---|---|
| Given this input, did the model route to the right case? (would/will → case 8, not 13) | [`llm`](layers.md#llm--deterministic-assertions-on-real-model-output): `anyToolCalled` grounded by case number, against the real model |
| Did the reply drive the right app mode/UI? (dictation request → dictation mode) | [`dispatch`](layers.md#dispatch--what-your-app-did-with-the-response): fold the reply through your reducer, assert the STATE (not the pixels — that stays Playwright's) |
| New misroute in prod — add a case | append a YAML block, or `heyllm capture "<the misrouted input>"` promotes it into a golden case |
| Edited one prompt — did it break the others? | [`--changed-only`](config.md#--changed-only-only-pay-for-what-actually-changed) + `heyllm triage` |

The three test systems unify as the gated pyramid: the cheap deterministic layers
(static/exec/dispatch) run first and gate the expensive real-model layer, and the Jest/Playwright
you already have get wrapped as `exec` stages rather than rewritten.

```yaml
kind: llm
cases:
  # 1. would/will must recommend CASE 8 — real model, deterministic assertion
  - name: would-vs-will-recommends-case-8
    system: exec:../../src/buildPrompt.ts      # the same builder production calls
    prompt: "what is the difference between would and will?"
    expect:
      anyToolCalled: { names: [recommend_case], args: { caseNumber: 8 } }

  # 2. a dictation REQUEST must land the user in dictation mode. The LIVE model
  #    picks the call; dispatch folds it through the app's own reducer and asserts
  #    the STATE the user reaches — the whole reply→mode chain, not a hardcoded call.
  - name: dictation-request-opens-dictation-mode
    system: exec:../../src/buildPrompt.ts
    prompt: "let me type what I hear instead of speaking"
    dispatch:
      module: ../../app/modeReducer.js
      initialState: { mode: speaking }
      expect: { state: { mode: dictation } }
```

```bash
# 3. edit ONE prompt, then check the blast radius
vim src/prompts/router.txt
heyllm run --changed-only   # re-runs live ONLY the cases whose resolved PAYLOAD moved;
                            # replays the rest from cache at zero tokens
heyllm triage               # any green→red case: YOUR-CHANGE (this edit) vs MODEL-DRIFT
```

The isolation is empirical, not a static proof: a payload fingerprint flags which cases the edit
moved, an actual re-run checks them, and `triage` attributes any regression — bounded by model
determinism (`repeat`/`passRate`), not a dependency graph.

## Works on any LLM pipeline, not just chatbots

heyllm asserts on **inputs and outputs**, never on a chat UI — so the same layers test whatever
your model actually does:

| you're building | what a layer checks | which layer |
|---|---|---|
| **RAG / doc Q&A** | the answer stays inside the retrieved source and invents no policy | `judge` + `citeSpan` |
| **Extraction / classification** | the JSON has the right fields, types and enums — every time | `llm` + matchers |
| **Text-to-SQL / codegen** | the generated query is `SELECT`-only; the patch applies cleanly | `llm` + `exec`/`dispatch` |
| **Agents / tool pipelines** | a destructive tool is refused unless the state truly allows it | `dispatch` |
| **Translation / localization** | the reply is in the target language across every locale | `llm` + `judge` |
| **Moderation / safety** | an injection is refused and no secret leaks | `judge` |
| **Summarization** | every claim in the summary is supported by the source | `judge` + `rules` |

The examples throughout the docs lean on a support-assistant story only because one running
example is easier to follow — nothing in the tool is chat-specific.
