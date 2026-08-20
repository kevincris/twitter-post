# Validator

Rules 1–20 from `bearpaws_runner_prompt_v2.md`, as code. Dependency-free, Node ≥ 18.

```bash
node tools/validator/validate.js \
  --record queue/2026-08-19_morning_map.json \
  --payload payload.json \
  [--repo .] [--json]
```

Exit `0` = safe to post (warnings allowed, read them). Exit `1` = do not post.
`--json` emits a machine-readable report for the runner to attach to the record.

## The point

The model does not grade itself. Rule 7 recomputes every slot threshold from the
payload, rule 19 recomputes the post_event pairing and percentile, and rule 17
re-scores the text through the humanizer rather than trusting `humanizer_score`.
A record that asserts it cleared the bar and a payload that says otherwise is a
failure, not a disagreement.

## Rule notes

**2 / 10 — numerals.** Every numeral in the tweet, the thread, and the card must
resolve to a `claims[]` entry. Structural numerals (`30m`, `4h`, `ATR20`) are
exempt via a deliberately narrow list at the top of `validate.js`; every
exemption applied is printed in the report so it stays auditable. Widen that list
reluctantly — each entry is a hole in the rule.

The card scan covers text nodes, `data-value` attributes, **and CSS `content:`
strings**. That last one matters: a stylesheet can paint a numeral onto the card
that never appears in the markup, and a reader screenshots what was rendered.

**11 / 12 — the logo conflict.** `bearpaws_logo_white.svg` contains
`fill="white"`, which is not one of the four brand tokens. Inline it as markup and
rule 11 fails; recolor it and rule 12 fails. The card must embed it as a
`data:image/svg+xml;base64,` URI: rule 11 excises data URIs before scanning for
color literals, and rule 12 decodes the payload and compares SHA-256 against the
asset on disk. Both pass, and the file stays self-contained.

**13 — blank detection** is a heuristic: total compressed IDAT bytes below 5000
for a 1600×900 canvas means almost nothing was drawn. It catches an all-dark
render, not a subtly broken one. Looking at the PNG is still the runner's job.

**16 — two-sidedness** is a warn-not-fail heuristic, per the spec, *except* that
a detected one-sided map without `risk_flags: ["one_sided_map"]` is a hard fail.
The flag is what routes it to manual review, so omitting it is the actual defect.

## Tests

```bash
npm test
```

27 negative cases: each mutates the known-good fixture one way and asserts the
intended rule fires. `npm run fixture` rebuilds the passing example from
`fixtures/payload.json` (needs `npx playwright install chromium` locally).

## Calibration

`ATR_RANGE_MULT` (0.35), `ATR_PROX_MULT` (0.15), `HUMANIZER_MAX` (30) and
`SIMILARITY_MAX` (0.85) are the placeholders the spec's open questions flag.
They live in one block at the top of `validate.js`. Backfill payloads, read the
skip-rate distribution, then move them.
