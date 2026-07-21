# heyllm docs

The [top-level README](../README.md) is the 60-second start. These pages are the full reference.

- **[why.md](why.md)** — why heyllm exists, the five things that fall out of the one rule, the
  comparison with promptfoo / DeepEval, and the "when the model's reply is your router" story.
- **[layers.md](layers.md)** — every layer kind: `static` · `exec` · `http` · `dispatch` ·
  `scenario` · `conversation` · `llm` · `judge` · `chain`.
- **[config.md](config.md)** — `heyllm.yaml`, profiles, matchers, path/template rules, `exec:` refs,
  `--changed-only`, `fingerprintIgnore`, `maxCacheAgeDays`, and testing the prompt you actually ship.
- **[cli.md](cli.md)** — the CLI, the `pipelines` dashboard, CI/CD, cost reporting, `doctor`,
  bulk `ingest`, and the programmatic API.

Migrating an existing suite with a coding agent? Point it at **[AGENTS.md](../AGENTS.md)** — a
condensed, validator-checked spec, not this prose.

The [case study](../CASE-STUDY.md) is the two-day story that produced the tool.
