# Case study: what a test suite measures, and what it misses

> Findings from the first production project to adopt `heyllm`. Every number was
> measured. **Read the "What this is not evidence of" section too** — the honest
> reading of this data is narrower than the headline.

**The system under test.** A language-learning app with a hands-free voice tutor
built on Gemini Live over a WebSocket. The model can call 16 tools — show a
grammar card, open a video, start a lesson, switch modes. The user is often
driving, so "can they look at the screen right now?" changes what the assistant
may do.

It already had **96 test files** — 52 Jest suites and 45 harness scripts — and
they were all green. Three shipped bugs were found in one day.

**None of them required a new tool to find.** All three were reachable with the
Jest suite that was already there. Two of the fixes are, in fact, plain Jest
tests. What was missing was not tooling; it was **checking that the tests were
pointed at what production actually runs**. That is the real subject of this
document.

---

## Bug 1 — The tests validated a prompt production never sends

The suite rebuilt the system prompt in a test helper. Production assembled it in
the route handler. Nobody had compared the two.

```
production   58,392 chars   (11 sections)
tests        53,947 chars   ( 2 sections)
missing       4,445 chars   (7.6%)
```

Size was not the problem — *which* sections were missing was:

| missing section | what it does |
|---|---|
| `persona` | the character voice implicated in a real user complaint |
| `memory` | what the assistant remembers about this user |
| `recentSession` | continuity with previous conversations |
| `reviewVocab` | **"when presenting a practice exercise, weave in one of the learner's review words"** |

That last one directly contradicts a rule added the same morning: *"when the
learner says they'll produce the English themselves, your turn contains zero
English."* Review words **are** English words. The instructions fight — and no
test could see the fight, because no test loaded the section that starts it.

**Fix:** extract the assembly order into one function that both the route and the
test helper call. Drift becomes structurally impossible. *This fix has nothing to
do with `heyllm`* — it is ordinary refactoring, and it would have worked just as
well behind Jest.

**What happened next is the point.** With the real prompt, a case that had been
passing 4/4 started failing **0/6**. The green was never real.

> If your prompt is assembled in code, ask what your tests are actually sending.
> A test that builds its own prompt is testing a program you do not ship.

---

## Bug 2 — The app suppressed a visual, then told the model it hadn't

The assistant can advance a lesson to its video stage. The client correctly
refuses to load videos when the user cannot see the screen. That part worked.

But the response handed **back to the model** was a fixed string:

```js
// tool response — screen state was not a parameter
note: "Example clips are appearing on the learner's screen.
       Invite them to play one and repeat its sentence aloud."
```

So the model was told clips were on screen and said *"go ahead, play the video"*
— to someone driving. The app was right; the **feedback loop** lied.

A sibling function in the same file already did this correctly, branching on
screen state. The stage-transition handler simply never received the state.

```diff
-function toolResponse(call) {
+function toolResponse(call, screenState) {
   if (stage === "video") {
+    if (screenState === "hidden")
+      return { note: "The learner cannot see the screen, so NO clips were shown.
+                      Do NOT mention videos or looking at anything." };
     return { note: "Example clips are appearing on the learner's screen. …" };
```

**This was found by reading, not by the tool** — while porting the tool handler
into a pure reducer, line by line against the original. The regression test that
now pins it is a **Jest** test. What `heyllm` contributed was forcing the port
that made the read happen.

---

## Bug 3 — A whole mode was broken, in one language

The voice tutor has an "English conversation" mode: the assistant should speak
English so the learner can practise listening. Testing it was a two-line case:

```
✗ submode-conversation-opens-in-english
    ↳ expected an English sentence, got: 반가워요! 오늘은 어떤 영어 표현을…
```

Entirely in Korean. The mode instruction — *"your replies are natural spoken
ENGLISH"* — was in the prompt. It lost to a sentence near the very top: *"Always
respond in Korean."*

The team had hit this exact failure in the text chat six weeks earlier and built
a fix: a final language section appended **last**, to win on recency. Its comment
reads:

> *"…later sections inject large amounts of Korean data and push the top-level
> rule out. Re-assert the language rule as the LAST section to recover recency
> advantage. (measured, en locale)"*

The voice path never used it. `grep` for that guard in the voice route: **zero
hits**. A fix that shipped for one surface silently did not apply to the other —
and not only for conversation mode. **Thirteen non-Korean locales** were running
hands-free with no language guard at all.

This one *was* surfaced by a test — but only because the sub-mode axis was
finally exercised. Nothing prevented that test from being written in Jest a year
ago. It simply never was.

---

## Bug 4 — The broken path was the *default* path

A later session took the same suite back to the role-play mode. Tapping
"role-play" is supposed to work like this: if the learner has already mentioned
a scenario, open that scene in English; if not, ask them — in their own language
— what to act out.

The second branch had a test. The test was opt-in, and it was red.

Two things made it worse than it looked. First, **there is no scenario picker in
the product.** Tapping the mode card auto-sends "let's role-play!" 250 ms later,
so "no scenario anywhere" is not an edge case — it is what happens to every user
who taps the button. Second, what the model actually did was not what the test
described. Measured through the real endpoint, 6 times out of 6, it invented a
café, cast the learner as a customer, and opened in English:

```
answer:    Hello! Welcome to Moody's Cafe. What can I get for you today?
situation: You are a customer at a cafe, and I am the barista.
```

A learner taps a button and is suddenly a customer in a café, in a language they
are still learning, with no idea why.

### The same fidelity trap, one level deeper

Bug 1's fix — one shared assembly function — held. The test harness still called
the builders directly, and that was still a different program: production wraps
the base prompt in 13 further sections, tries a *smaller model first* for casual
turns, and streams over SSE. Measuring through the builders and measuring through
the route disagreed about what the bug even was:

| | via the builders | via the real route |
|---|---|---|
| what the model did | asked for a scenario, **in English** | **invented a café** and opened in English |
| what you would fix | the language rule | the "don't invent" rule |

Extracting the assembly was necessary and not sufficient. The harness was
rewritten to POST to the running dev server with a forged session cookie, so
there is nothing left to reassemble.

### Three findings that only measurement could have produced

**A prohibition primed the thing it prohibited.** The first fix said: *"never
open a café, an interview, a restaurant or any other scene the learner did not
ask for."* Scenario-given cases went from 8/8 to 6/8 — the model started
avoiding **interviews**, which is exactly the scene it was supposed to open when
the learner had mentioned one. The negative examples leaked across the branch
boundary. The prohibition now names no scenes at all, and a test asserts it never
will again.

**The UI decided what the prompt should say.** The fix also told the model to
offer a tappable example in `suggestedReply`. That field renders as a card with a
*text-to-speech button* — it exists so learners can hear an English line. Putting
a Korean scenario request there would have been read aloud by an English voice,
and the base prompt already said to leave it null on setup turns. Two
instructions, in conflict, and the measurement (2 of 8 samples empty) is what
surfaced it. Reading the component settled which one was right.

**The harness could not fail correctly.** Sampling the real endpoint hit a
production rate limit of 50 requests/hour. Twelve blocked samples were reported
as `0/12` — identical to a total behavioural regression. A test that cannot tell
"the model got this wrong" from "I never got an answer" will eventually lie in
both directions. Blocked samples are now retried, then excluded from the
denominator, and **a run that measures nothing is never green**.

Final, through the production route: 24/24 across all three branches, up from
0/6 on the branch every user hits.

---

## What this is not evidence of

**It is not evidence that Jest or the existing 96 files were inadequate.** They
were pointed at the wrong artifact. A suite that faithfully tests a prompt you
never ship will be green forever, in any framework. The failure was in test
*design*, not test *tooling*, and saying otherwise would be marketing.

**It is not evidence that `dispatch` is free to adopt.** The document above makes
extracting a pure reducer sound like a checklist item. Here is what it actually
took in a 6,000-line React component:

- The handler read state from `useRef` for some values and from functional
  `setState` (`setPanel(prev => …)`) for others. **A reducer needs to read
  current state, and one of those cannot be read outside a render.** Mirror refs
  had to be introduced, and all 21 setter call sites routed through a helper so
  the mirrors could never fall behind.
- The first extraction was a *parallel copy*, not wired in. That is worse than
  useless: the `dispatch` tests then verify a mirror, and the mirror drifts. It
  took a second pass — plus a guard test asserting the component has **no** tool
  branches of its own — to close that.
- The copy had already drifted before it was wired: the original cleared the
  screen panel when the user went hands-free, the copy did not. A test caught it
  only because the original was re-read.

Budget a day for a handler of this size, and expect to touch state management,
not just add a file. The payoff is real — that layer runs on every commit with
no model calls — but "extract a pure reducer" is a refactor, not a config change.

**It is not evidence that the tool's own claims are self-verifying.** Dogfooding
kept finding `heyllm` committing the exact failure it exists to catch — reporting
a verdict it had not earned. Four more, all fixed in 0.1.5, all with regression
tests:

| what happened | why it mattered |
|---|---|
| `settings.envFile` keys were inherited by `exec` children | a wrapped Jest suite whose live tests self-skip on `if (process.env.API_KEY)` **stopped skipping** — every pre-deploy run silently made paid API calls the author had gated off |
| one bad path in a multi-item `include` was ignored | a *single* missing include already errored; a **list** swallowed the typo as long as a sibling matched, so coverage dropped to whatever was left and the run stayed green |
| `--only behaviour` (a typo for `behavior`) selected nothing | printed `RESULT: PASS — 0/0 cases`, exit 0. One wrong character turned an entire CI gate green while claiming to have run |
| an `exec` harness had no way to say "I could not measure" | a rate-limited run reported failures indistinguishable from a real regression |

The first three are the same bug wearing different clothes: **the tool did less
than it was told, and said nothing.** That is precisely what it asks users to
look for in their own suites, which is the argument for dogfooding rather than
against it — none of these surfaced in the tool's own 84-test suite until it was
pointed at a real project.

The judge-trust gate was also wrong on first release, in exactly the same shape.
It measured agreement **between votes inside one run**:

| run | votes | spread within run |
|---|---|---|
| 1 | (9, 8) | 1 |
| 2 | **(2, 3)** | 1 |
| 3 | (10, 9) | 1 |

Every run agreed with itself, so the gate called all three stable — and run 2's
tight internal agreement stamped confidence on a score six points off. **The
variance was on the time axis, and no number of votes can see it.** The fix was
a run-axis ledger with attribution: identical output hash + moving scores means
the *judge* moved, so the rubric is missing a decision rule and more samples will
not help.

---

## What the adoption actually cost, and what it bought

One YAML file wrapping the existing 96 files as-is, plus a few native cases:

```yaml
layers:
  - { name: hygiene,  kind: static,   include: tests/static.yaml }
  - { name: unit,     kind: exec,     cases: [{ name: jest, command: "npx jest --ci" }] }
  - { name: dispatch, kind: dispatch, include: tests/dispatch.yaml }   # no model calls
  - { name: behavior, kind: llm,   provider: gemini,  include: tests/behavior.yaml }
  - { name: quality,  kind: judge, subject: gemini, judge: local-cli, include: tests/quality.yaml }
```

| | |
|---|---|
| Existing tests rewritten | **0** — wrapped by the `exec` layer |
| Reducer extraction + wiring | **~1 day**, including one false start |
| Deterministic layers (`static`/`exec`/`dispatch`) | **$0** — no model calls |
| Live behaviour layer, full run | **~20s**, 7 scenarios |
| Judge layer (local CLI), full run | **~30s** |

Final state, all against real APIs: `hygiene` 4/4 · `unit-jest` 845 tests ·
`harness-pure` 4/4 · `dispatch` 7/7 · `behavior` 7/7 · `quality` 8.8–9.6/10
(vote spread ±0.4, down from a 5.6–9.3 swing before the rubric was rewritten as
request-fulfilment rather than surface-property matching). One command, ~70s,
run by hand before each deploy.

### Postscript: the "known flaky baseline" was neither known nor flaky

Four harness scenarios had been failing on every run for long enough to be
written off as sampling noise, and were recorded as an accepted baseline —
including in the first draft of this document. Promoting that harness to the
production prompt assembly settled it, and the answer was three different things
wearing one costume:

1. **Two were over-strict assertions.** They pinned a *tool name* where two
   tools produce the same user-visible result. The model consistently picks the
   other one — with the thin prompt and with the full one. Rewritten to assert
   the outcome, they pass.
2. **One was the test harness lying to the model.** Its tool-response simulator
   returned "a card is now on the learner's screen" regardless of screen state,
   while the real client returns "NOTHING was shown" when the screen is hidden.
   The harness contained the same defect as Bug 2 above — in the *test* this
   time, which is why the test could never reproduce Bug 2's class of failure.
3. **One was a real, frequent bug the first two were masking.** With the
   simulator corrected, the model still failed: in hands-free mode it announces
   *"I'll put it on your screen"* **while calling the tool**, one round before
   the response tells it nothing was shown. Live speech streams as it is
   generated, so that promise is already in the user's ear — and no screen ever
   lights up. Fixed with an explicit rule and now green.

Final: **44 pass / 0 fail**, from what had been filed as an immovable baseline.

The takeaway is not that the tool found these. It is that *"we know those four,
they're flaky"* was a story the team told itself for weeks, and one honest
question — *is the test even sending what production sends?* — dissolved it.

---

## The durable payoff: the loop after the audit

The four bugs above were a one-time audit. What keeps the suite in the loop afterward is a check that runs on every prompt tweak — and here the model output **is** the router: an input picks a grammar case, a mode, a UI panel, and the reply text is almost incidental. Three questions recur daily, each already covered by a documented layer.

**Did the input route to the right recommendation?** *"What is the difference between* would *and* will*?"* should recommend case 8; a bad edit sends it to case 13. The [`llm`](README.md#llm--deterministic-assertions-on-real-model-output) layer asserts the real model's call, with `system:` shelled in from the production builder so the test sends what production sends:

```yaml
kind: llm
cases:
  - name: would-vs-will-routes-to-case-8
    system: "exec:node scripts/print-system-prompt.mjs"
    prompt: "what is the difference between would and will?"
    expect:
      anyToolCalled: { names: [recommendCase], args: { caseNumber: 8 } }
```

The assertion pins the case number, not the branch — the over-strict-tool-name trap from the postscript, avoided by construction: assert the recommendation, not which of two tools produced it.

**Did the output drive the right UI state?** A dictation request should open the dictation-mode panel. The [`dispatch`](README.md#dispatch--what-your-app-did-with-the-response) layer folds the recorded calls through the app's own reducer and asserts the state reached — no model calls, gated on every commit. This pins the branch, not the pixels — the rendered DOM stays Playwright's job — but the branch is where the misroute lives.

```yaml
kind: dispatch
cases:
  - name: dictation-request-opens-dictation-panel
    module: ../../app/assistantReducer.js
    initialState: { mode: chat, panel: null }
    calls: [{ name: set_mode, args: { mode: dictation } }]
    expect: { state: { mode: dictation, panel: dictation } }
```

**A new misroute showed up in prod?** Append a case, or `heyllm capture "<the misrouted input>"` seeds it as a reviewable golden case — capture writes the prompt and tags only; a human adds the `expect:` in review, so it records what to check, it does not yet assert the fix.

### The one-prompt blast-radius loop

Retuning one prompt should not cost a full-suite re-run. `heyllm run --changed-only` re-runs live only the cases whose resolved payload actually moved and confirms the rest by **replaying their last passing output through the assertions — not by calling the model again**. A case that flips green→red is a flip to attribute, not yet a regression: `heyllm triage` runs its own A/B probe and returns *flaky* (resampling noise), *your-change* (this edit), or *model-drift* (the provider), each with a confidence level. It does not pre-judge fault.

Be exact about what this proves. The isolation is empirical — fingerprint impact detection, an actual re-run of what moved, triage attribution — not a static dependency graph and not a guarantee. An "untouched" case is proven unchanged in *input*, not re-proven live; provider drift on those surfaces only when [`maxCacheAgeDays`](README.md#maxcacheagedays-re-verify-on-a-cadence-to-catch-provider-drift) forces a re-run. Its floor is model determinism: a case at `passRate < 1` can flip on resampling, which is `repeat`'s job to characterise, not [`--changed-only`](README.md#--changed-only-only-pay-for-what-actually-changed)'s to hide.

---

## The transferable lesson

Every finding here — four product bugs and five of the tool's own — is the same
shape:

> Something was measured. It just wasn't the thing that breaks.

Prompt length was measured; section content was not. Tool calls were asserted;
what the app did next was not. Vote agreement was computed; run-to-run drift was
not. An `--only` filter was honoured; whether it matched anything was not. A
harness counted failures; whether it had received an answer at all, it did not.

The uncomfortable version: **a green test and an unrun test look identical from
the outside.** Everything above is a variation on failing to tell them apart.
Before adding a layer, it is worth asking of every green test you already have:
*what exactly is this comparing, and is that what ships?*

## Reproducing this on your own project

1. Point one `exec` case at your existing test command. Nothing to rewrite.
2. Add one `llm` case whose `system:` comes from the **same code path production
   uses** — `exec:` refs let you shell out to your own prompt builder.
3. Diff what your test sends against what production sends. If the endpoint is
   reachable from your test environment, skip the diff and **call the endpoint**
   — then there is nothing to keep in sync. Fix any gap before trusting
   anything else.
4. Only then extract a reducer and add a `dispatch` layer. Budget a real day for
   it, and wire it in — a parallel copy is worse than nothing.
5. Prove your harness can fail. Break the thing on purpose and confirm it goes
   red; then block its network and confirm it says *"could not measure"* rather
   than *"failed"*. Both directions, or you do not know what green means.
