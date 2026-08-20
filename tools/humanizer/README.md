# Humanizer CLI (vendored)

Dependency-free Node implementation of the "Humanizer v2.2" analyzer for the
Bearpaws tweet pipeline. Score 0–100, higher = more AI-like. Statistical tells
(burstiness, TTR, trigram repetition) only engage on texts of 4+ sentences /
60+ words, so short tweets are judged purely on pattern hits — by design.

## Install

Copy this folder into the repo as `tools/humanizer/`. No npm install needed;
requires Node ≥ 16.

```
your-repo/
  tools/humanizer/
    cli.js
    README.md
```

## Commands

```bash
echo "text" | node tools/humanizer/cli.js score      # prints score; exit 1 if ≥ 30
node tools/humanizer/cli.js score -f draft.md
node tools/humanizer/cli.js analyze -f draft.md      # full report
node tools/humanizer/cli.js analyze --json < in.txt  # JSON for the validator
node tools/humanizer/cli.js stats -f essay.txt
node tools/humanizer/cli.js suggest -f essay.txt
node tools/humanizer/cli.js humanize --autofix -f a.txt
```

`score` sets exit code 1 when the score is ≥ 30, so the validator (and CI)
can gate on the exit code directly:

```bash
echo "$TWEET_TEXT" | node tools/humanizer/cli.js score || echo "humanizer gate FAILED"
```

## What it checks

Pattern hits: Tier-1/Tier-2 AI vocabulary, AI phrases, filler, chatbot
artifacts, vague attributions, stacked hedging, copula avoidance ("serves
as"/"boasts"), negative parallelism ("not just X, it's Y"), rule-of-three
cadence, em-dash overuse, curly quotes. Statistics on longer prose:
sentence-length CoV (burstiness), type-token ratio, trigram repetition.

`humanize --autofix` applies only the safe mechanical fixes (filler
replacements, straight quotes, capitalization repair) and re-scores;
everything else needs a rewrite, listed by `suggest`.

## Calibration

The < 30 threshold is a placeholder — score a few weeks of real drafts and
read the distribution before trusting it (see the runner prompt's open
calibration questions). Word lists live at the top of `cli.js`; extend them
as new tells show up in drafts.
