# CLI, CI/CD, cost, and the programmatic API

See also: [config.md](config.md) · [layers.md](layers.md) · [why.md](why.md).

## CLI

```
heyllm run          run the pyramid          --only a,b --grep re --tags t1,t2
heyllm list         catalog: every case's name + description + tags — no runs, no model calls
heyllm pipelines    dashboard: what exists, how it flows, last-run results   --verbose
heyllm ingest       bulk-import a JSONL export  --map input=<path> --dedup near --dry-run
heyllm triage       run + A/B probe          --update-baseline --keep-going
heyllm validate     lint without executing   --profile ci
heyllm capture      grow the golden corpus   "input" --tags a,b --note ...
heyllm doctor       judge reliability from the ledger — zero model calls
heyllm init         scaffold a new project
```

### `heyllm list` — the catalog (what each case verifies)

Alias `ls`, `cases`. Give each case a one-line `description:` and the intent stops living in a YAML
comment nobody reads:

```yaml
cases:
  - name: closing-does-not-credit-learner-with-my-correction
    description: the tutor must not praise the learner for a correction the tutor itself supplied
    tags: [tutor, attribution]
    ...
```

`heyllm list` then prints the whole suite as a catalog — every pipeline, every case's name +
description + tags — with **no run and no model calls**. It's the "what do we actually check?" map
that a pass/fail dashboard can't give:

```
◆ heyllm  12 pipelines · 86 cases      catalog · no runs, no model calls

●  behavior  llm · gemini  12 cases
     closing-does-not-credit-learner-with-my-correction
       the tutor must not praise the learner for a correction the tutor itself supplied
       #tutor #attribution
     ...

7/86 cases have no description — add `description:` in the YAML so the catalog reads at a glance.
```

`description` is free-form metadata: surfaced here, ignored by execution (a non-string is a `validate`
error). An undescribed case is counted out loud, so the catalog can't quietly imply coverage it
doesn't explain. Flags: `--only a,b` (pipelines) / `--tags t` (cases carrying a tag) / `--grep re`
(case names) focus it; `--json` is machine-readable.

### `heyllm pipelines` — zero-cost dashboard

Alias `status`. Reads the config and the last run, no model calls. See every pipeline, the
gated pyramid it flows through, and how each stage did last time, at a glance:

```
◆ heyllm  7 pipelines  ·  gated pyramid: cheap → expensive, a failing gate halts the rest
  last run  FAIL  ·  33/36 cases  ·  9 cached  ·  ~816.0k tok  ·  1.3s  ·  3m ago

  ●  hygiene    static    gate   4 cases   ✓4                       44ms
  │
  ●  dispatch   dispatch  gate   9 cases   ✓9                       16ms
  │
  ●  behavior   llm              11 cases  ✓9 ✗1 ⋯9        44.1s · ~816.0k tok
  │     ↳ failed: modal-difference-grounds-on-base-case-8
  │     ↳ flaky:  s22-situation-practice (flips across runs)
  │
  ●  quality    judge            3 cases   ✓1 ○2                    15.8s

  ✓ pass   ✗ fail   ○ skipped/unchanged   ⋯ cached replay   ⊘ halted   gate halts on fail
```

It names the failed cases, flags any that flip across runs (flaky), and shows per-stage token spend.
Flags: `--verbose` (tags + driver), `--only a,b` / `--tags t` (focus), `--watch` (live-refresh every
2s), `--json` (machine-readable, for CI badges).

## CI/CD (GitHub Actions)

```yaml
name: llm-tests
on:
  push: { paths: ["prompts/**", "tests/**", "heyllm.yaml"] }   # prompt change → full re-verify
jobs:
  heyllm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx heyllm run --profile ci --triage --report junit
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: heyllm-report, path: heyllm-report.xml }
```

Exit codes: `0` pass · `1` gated failure · `2` config/usage error **or an unreachable provider**.
Triage verdicts are embedded in the JUnit failure text, so your CI UI shows *why* it failed, not just
*that* it failed.

> **A provider we could not reach is never a pass.** If the API is down, the key is missing, or your
> local Ollama isn't running, those cases produced *no verdict* — so they are reported under
> `◆ NOT VERIFIED`, force a non-zero result even on a warn-only layer, and exit **2** rather than 1.
> "We never got to ask" is a different fact from "we asked and it failed", and only one of them means
> your prompt is broken.

## What did it cost?

Every run that touches a model reports its tokens, right above the verdict:

```
TOKENS: 71,204 in · 1,088 out · 24 calls
  ⚠ 6 of 24 call(s) reported no usage (local/command) — the numbers above are a FLOOR
```

That line is how you find out a suite is shipping 402 tool declarations (~67k tokens) on *every single
request* before anyone opens a bill. Per-layer and per-case totals are in the JSON report;
`--verbose` breaks it down per provider.

**heyllm ships no price table and prints no dollar estimate.** A vendored price is right the day it
ships and silently wrong forever after — the exact failure this tool exists to catch, denominated in
dollars. And `openai-compatible` is the "any baseUrl" kind: it covers Ollama, vLLM and LM Studio where
marginal cost is zero. Tokens are a fact the provider reports; the price is on your invoice. A call
whose provider reported nothing counts as **unmetered**, never as zero — so the totals are labelled a
floor rather than quietly under-reporting.

## Is the judge worth listening to? — `heyllm doctor`

`heyllm doctor` reads the run-axis ledger and answers, with **zero model calls**, whether each rubric
item is stable enough to gate a build:

```
◆ judge reliability — 3 rubric item(s)

stable   quality/refund-answer#cites-source      8–9 over 6 run(s), spread 1
UNSTABLE quality/refund-answer#no-invented-policy  2–10 over 6 run(s), spread 8
    ↳ the judges quoted the SAME evidence from the SAME output and still scored it differently.
      This is a missing decision rule, not sampling noise — more votes will not help. Add `rules:` to this item.

1 item(s) cannot currently gate a build.
```

Exit code is non-zero when any item is unreliable, so it can run in CI as a cheap guard on your rubric
quality. (The `reliability:` block that populates this ledger is documented in
[layers.md → judge](layers.md#judge--llm-as-a-judge).)

## Growing the corpus in bulk

`heyllm capture` takes one complaint. `heyllm ingest` takes the whole export:

```bash
jq -c '.[]' zendesk-export.json > rows.jsonl        # any store; Sentry/Intercom/psql too
heyllm ingest rows.jsonl \
  --map input=comment.body \
  --map expected=custom_fields.expected_behavior \
  --map id=id --source-name zendesk --dedup near --dry-run
```

```
✓ 275 rows → 41 new · 198 duplicate-in-batch · 36 already in ledger
```

Every ingested case is written **skipped and TODO-marked**, so it reports as `○ unverified` — never as
a pass:

```
▸ quality 0/41 cases (41 skipped, unverified)
```

That is the point. An assertion-less case iterates zero expectations and returns ok, so bulk-importing
275 rows without this would add 275 green ticks that verify nothing. The validator then refuses to let
anyone remove `skip:` while the TODOs remain — a parked backlog keeps CI green, and finishing a row is
gated on actually finishing it.

Rubric skeletons use `ask: binary` (a harvested "expected behavior" is a fulfilment question, not a
1–10 judgement) and emit `rules:` as literal TODOs. **They are never machine-written**: `heyllm
doctor`'s whole diagnosis is only meaningful if `rules:` is deliberate human policy.

Dedup is exact-by-digest always, `--dedup near` (trigram Jaccard) opt-in — a false merge silently
deletes a distinct test, which is losing coverage while believing you gained it. Merged rows keep
their text in `source.mergedRaw`; provenance (`source.system/id/url/digest/raw`) rides with every case
so a reviewer can trace back to the original ticket. Re-running the same file writes nothing.

## Programmatic API

```ts
import { loadConfig, runSuite } from "hey-llm-you-okay";
const config = await loadConfig("heyllm.yaml", { profile: "ci" });
const summary = await runSuite(config, { triage: true });
if (!summary.ok) process.exit(1);
```
