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

**It is not evidence that the tool's own claims are self-verifying.** `heyllm`'s
judge-trust gate was wrong on first release, in exactly the same shape as the
bugs above. It measured agreement **between votes inside one run**:

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

Final state, all against real APIs: `hygiene` 4/4 · `harness-pure` 4/4 ·
`dispatch` 7/7 · `behavior` 7/7 · `quality` 9.57/10 (vote spread ±0.28, down
from a 5.6–9.3 swing before the rubric was rewritten as request-fulfilment
rather than surface-property matching).

Two pre-existing harness failures remain and are **not** fixed by any of this:
a screen-state tool-choice drift in two scenarios, reproduced on a clean
checkout before any change, and one dictation passage-length case. They are
recorded as a known baseline rather than papered over.

---

## The transferable lesson

All four findings — three product bugs and the tool's own — are the same shape:

> Something was measured. It just wasn't the thing that breaks.

Prompt length was measured; section content was not. Tool calls were asserted;
what the app did next was not. Vote agreement was computed; run-to-run drift was
not. Before adding a layer, it is worth asking of every green test you already
have: **what exactly is this comparing, and is that what ships?**

## Reproducing this on your own project

1. Point one `exec` case at your existing test command. Nothing to rewrite.
2. Add one `llm` case whose `system:` comes from the **same code path production
   uses** — `exec:` refs let you shell out to your own prompt builder.
3. Diff the length of what your test sends against what production sends. Fix any
   gap before trusting anything else.
4. Only then extract a reducer and add a `dispatch` layer. Budget a real day for
   it, and wire it in — a parallel copy is worse than nothing.
