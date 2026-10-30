# Validation

Run `npm test` and `npm run benchmark`. Paste the real output into your submission; do not paste numbers you haven't produced.

## What exists

| Suite | What it checks | What it does **not** check |
|---|---|---|
| Unit/integration tests (32) | gate maths, grammar validation, provenance, grounding check, agent loop against a local mock Token Factory, model auto-resolution, JSON-mode fallback, NDJSON streaming, server re-gating, Windows/space-path startup | real model quality |
| Adversarial gate suite (39) | off-by-one budgets, malformed/smuggled params, invented types, unknown facts; labels written from an independent oracle per case | diagnosis accuracy |
| Scenario fixture suite (16) | bundled actions vs labeled outcomes | anything beyond the 4 fixtures |
| Live injection test | whether real Nemotron is influenced by hostile log lines, and whether anything unsafe is approved | general jailbreak robustness |

## Record before submitting (fill in yourself)

- Date/time of a successful **Verify live call**: ____
- Reasoning model ID that answered: ____  · Fast model ID: ____  · latencies: ____
- Live agent run on the DB scenario: rounds __, proposals __, blocked __, revised __
- Live injection test: influenced proposals __, unsafe approvals __
- Tavily: sources returned __ (if used)
