# Case study: three silent bugs in a shipped voice assistant

> Real findings from the first production project to adopt `heyllm`, in one day.
> Every number below was measured, not estimated.

**The system under test.** A language-learning app with a hands-free voice tutor
built on Gemini Live over a WebSocket. The model can call 16 tools — show a
grammar card, open a video, start a lesson, switch modes. The user is often
driving, so "can they look at the screen right now?" changes what the assistant
is allowed to do. This is a hard target: no HTTP request to assert on, a system
prompt assembled at runtime from eleven pieces, and behaviour that depends on
device state.

It already had **96 test files** — 52 Jest suites and 45 bespoke harness scripts.
All green.

---

## Bug 1 — The tests were sending a prompt production never sends

The suite validated the model's behaviour by rebuilding the system prompt in a
test helper. Production assembled it in the route handler. Nobody had compared
the two.

```
production   58,392 chars   (11 sections)
tests        53,947 chars   ( 2 sections)
missing       4,445 chars   (7.6%)
```

Size was not the problem — *which* sections were missing was:

| missing section | what it does |
|---|---|
| `persona` | the character voice that made the assistant chatty in a real user complaint |
| `memory` | what the assistant remembers about this user |
| `recentSession` | continuity with previous conversations |
| `reviewVocab` | **"when presenting a practice exercise, weave in one of the learner's review words"** |

That last one directly contradicts a rule added the same morning: *"when the
learner says they'll produce the English themselves, your turn contains zero
English."* Review words **are** English words. The two instructions fight — and
the test could never see the fight, because the test never loaded the section
that starts it.

**Fix:** extract the assembly order into one function that both the route and
the test helper call. Drift becomes structurally impossible.

**What happened next is the point.** With the real prompt, a test that had been
passing 4/4 started failing **0/6**. The green was never real — it was measured
against a prompt no user ever receives.

> If your prompt is assembled in code, ask what your tests are actually sending.
> A test that builds its own prompt is testing a program you do not ship.

---

## Bug 2 — The app suppressed the visual, then told the model it hadn't

The assistant can advance a lesson to its video stage. The client correctly
refuses to load videos when the user cannot see the screen — someone driving
gets no video. That part worked.

But the response handed **back to the model** was a fixed string:

```js
// hands-free tool response, screen state not considered
note: "Example clips are appearing on the learner's screen.
       Invite them to play one and repeat its sentence aloud."
```

So the model was told clips are on screen, and dutifully said *"go ahead and
play the video"* — to a driver looking at the road. The app was right; the
**feedback loop** lied.

A sibling function in the same file had solved this properly, branching on
screen state and returning *"the learner cannot see the screen, so NOTHING was
shown."* The stage-transition handler simply never received the state.

```diff
-function toolResponse(call) {
+function toolResponse(call, screenState) {
   if (stage === "video") {
+    if (screenState === "hidden")
+      return { note: "The learner cannot see the screen, so NO clips were shown.
+                      Do NOT mention videos or looking at anything.
+                      Skip straight to the speaking practice." };
     return { note: "Example clips are appearing on the learner's screen. …" };
```

This is the joint `heyllm`'s `dispatch` layer exists for. Assertions on the
model's output pass: the model called the right tool with the right arguments.
The bug is entirely in what the app does next — and in what it tells the model
it did.

---

## Bug 3 — A whole mode was broken, in one language

The voice tutor has an "English conversation" mode: the assistant is supposed to
speak English so the learner can practise listening. Testing it was a two-line
case. It failed:

```
✗ submode-conversation-opens-in-english
    ↳ text: expected /[A-Za-z]+(?:[ ,]+[A-Za-z]+){3,}/ to match,
      got: 뉴욕에 놀러 간 무디예요! 반가워요. 오늘은 어떤 영어 표현을…
```

Entirely in Korean. The mode instruction — *"your replies are natural spoken
ENGLISH… greet them warmly in English"* — was present in the prompt. It lost to
a sentence near the very top: *"Always respond in Korean."*

The team had already hit this exact failure in the text chat six weeks earlier
and built a fix: a final language section appended **last**, to win on recency.
The comment on it reads:

> *"…later sections inject large amounts of Korean data and push the top-level
> rule out. Re-assert the language rule as the LAST section to recover recency
> advantage. (measured, en locale)"*

The voice path never used it. `grep` for that guard in the voice route: **zero
hits**. A fix that shipped for one surface silently did not apply to the other —
and it was not only conversation mode. **Thirteen non-Korean locales** were
running hands-free with no language guard at all.

---

## What it cost, and what it caught

Adoption was one YAML file wrapping the existing 96 test files as-is, plus a few
native cases:

```yaml
layers:
  - { name: hygiene,  kind: static, include: tests/static.yaml }
  - { name: unit,     kind: exec,   cases: [{ name: jest, command: "npx jest --ci" }] }
  - { name: dispatch, kind: dispatch, include: tests/dispatch.yaml }   # no model calls
  - { name: behavior, kind: llm, provider: gemini, include: tests/behavior.yaml }
  - { name: quality,  kind: judge, subject: gemini, judge: local-cli, include: tests/quality.yaml }
```

| | |
|---|---|
| Existing tests rewritten | **0** — wrapped by the `exec` layer |
| Real bugs found in one day | **3**, all shipped, all invisible to the existing 96 files |
| Cost of the deterministic layers | **$0** — `static`, `exec` and `dispatch` call no model |
| Model spend for the behaviour layer | **~20s per full run** |

The deterministic `dispatch` layer is the one that keeps paying: it replays
recorded tool calls through the app's own reducer, so "the model was right and
the UI did nothing" fails on every commit, for free.

---

## A fourth finding: the tool's own trust check was wrong

Worth recording because it is the same mistake in a different place.

`heyllm` measures whether a judge can be trusted before letting it gate a build.
The first implementation measured **agreement between votes inside one run**.
The real data looked like this:

| run | votes | spread within run |
|---|---|---|
| 1 | (9, 8) | 1 |
| 2 | **(2, 3)** | 1 |
| 3 | (10, 9) | 1 |

Every run agreed with itself. The gate saw three stable verdicts — and run 2's
tight internal agreement stamped confidence on a score six points off. **The
variance was on the time axis, and no number of votes can see it.**

`heyllm` now keeps a run-axis ledger and attributes the swing: if the judged
output hash is identical across runs while the scores move, the *judge* moved,
which means the rubric is missing a decision rule — more samples will not help.

The lesson generalises past this tool: **check which axis your measurement is
on.** All three product bugs above are the same shape — something was measured,
it just wasn't the thing that breaks.

---

## Reproducing this on your own project

1. Point one `heyllm` `exec` case at your existing test command. Nothing to rewrite.
2. Add one `llm` case whose `system:` comes from the **same code path production
   uses** — `exec:` refs let you shell out to your own prompt builder.
3. Diff the length of what your test sends against what production sends. If the
   numbers differ, stop and fix that before trusting anything else.
4. Extract your tool/action handler into a pure reducer and add a `dispatch`
   layer. It is free, deterministic, and it is where the shipped bugs were.
