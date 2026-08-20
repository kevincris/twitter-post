# Payload endpoint — contract (phase 1, three slots)

One HTTP route. Returns one JSON object. It is the only thing the generator is
allowed to get numbers from, so every field here is load-bearing: a number that
is not in this payload cannot appear in a tweet or on a card.

```
GET {BASE}/market_state?slot=<morning_map|london_open|recap>&instrument=XAUUSD
```

Auth: a static bearer header is fine. Respond `200` with the object below, or a
non-200 — the runner treats any non-200, non-JSON, or `market_state`-less
response as `skip_reason: "payload_unavailable"` and posts nothing. Never serve
a partial object with nulls standing in for real numbers; a skipped slot is
cheap, a wrong number on a card is not.

Phase 1 covers `morning_map`, `london_open` and `recap`. `ere` and `realized`
stay `null` until the event-response dataset exists; `pre_event` and
`post_event` are not scheduled until then.

## Shape

```jsonc
{
  "slot": "morning_map",              // echo the query param
  "now_utc": "2026-08-19T23:30:00Z",  // server time, ISO 8601, Z-suffixed
  "instrument": "XAUUSD",

  "session": { "holiday": false },    // true on holiday / no-liquidity sessions

  "market_state": {
    "last": 3408.2,
    "atr20": 28.4,
    "asia_range": { "high": 3414.0, "low": 3399.5 },
    "prior_day": { "high": 3421.8, "low": 3395.1, "close": 3410.0 },
    "levels": [
      { "label": "weekly open",    "price": 3402.0, "source": "calc" },
      { "label": "prior day high", "price": 3421.8, "source": "calc" }
    ]
  },

  "calendar": [
    { "event": "US Core PCE m/m", "tier": 1,
      "time_utc": "2026-08-20T12:30:00Z",
      "consensus": 0.3, "prior": 0.2 }
  ],

  "session_today": null,              // required for recap, null otherwise

  "prior_posts": [
    { "id": "01J...", "slot": "morning_map",
      "generated_at": "2026-08-18T23:30:00Z",
      "text": "…as posted…",
      "claims": [ { "assertion": "…", "value": 3412.4, "source_field": "…" } ],
      "card": { "template": "levels", "layout_variant": "ladder-left" } }
  ],

  "ere": null,
  "realized": null
}
```

## Field notes

**`session.holiday`** — the only thing standing between the account and a
`morning_map` posted into a dead tape. Validator rule 7 reads it directly.

**`atr20`** — 20-period ATR on daily bars. It is the denominator for both
`london_open` thresholds, so a definition change silently moves the posting rate;
if you change it, re-run the backfill.

**`asia_range`** — high and low over the Tokyo window, 23:00–07:00 UTC. State the
window in your implementation and keep it fixed. At the `london_open` slot
(07:30Z) the window has just closed, which is the point.

**`levels`** — every level the post is allowed to name. The generator cannot
invent one, and `label` is what it will call the level in prose, so write labels
that read naturally in a sentence ("weekly open", not "WO_1"). Keep the list
short; four or five is plenty.

**`calendar`** — today and the session ahead. `tier: 1` is what `pre_event` will
key off later; phase 1 only quotes the event name and `time_utc`.

**`prior_posts`** — the last 72 hours. **This is the state store.** Scheduled runs
cannot write to the repo, so rate limiting (rule 8), variant rotation (rule 14)
and similarity (rule 9) all depend on this array being populated and accurate.
An empty array means the generator believes nothing has been posted and will
happily repeat yesterday's layout and framing. `generated_at` and
`card.layout_variant` are the two fields most easily forgotten and most needed.

**`session_today`** — required when `slot=recap`, `null` otherwise. Recap grades
what was flagged against what happened, and a grade is only checkable if the
outcome is a payload field:

```jsonc
"session_today": {
  "high": 3419.4,
  "low": 3401.2,
  "last": 3416.8,
  "levels_triggered": [
    { "label": "prior day high", "price": 3421.8,
      "triggered": false, "first_touch_utc": null },
    { "label": "weekly open",    "price": 3402.0,
      "triggered": true,  "first_touch_utc": "2026-08-20T09:14:00Z" }
  ]
}
```

Without this the recap slot cannot pass rule 2 — it would have to assert an
outcome with no field behind it, which is the one thing the architecture forbids.

## Serving it from GitHub instead of an API

The payload does not have to come from a service. A `payload.json` committed to
this repo and read at its raw URL works, and the run already clones the repo
anyway:

One file per slot, because the payload differs by slot — `slot` must echo the
caller, and `recap` additionally carries `session_today`:

```
https://raw.githubusercontent.com/kevincris/twitter-post/main/data/payload.morning_map.json
https://raw.githubusercontent.com/kevincris/twitter-post/main/data/payload.london_open.json
https://raw.githubusercontent.com/kevincris/twitter-post/main/data/payload.recap.json
```

Committed payloads live in `data/`. The bare `payload.json` at the repo root is
gitignored on purpose: that is where each run writes the copy it fetched, and it
must never be confused with the committed source.

That removes the hosting problem entirely. It does not remove the producer
problem — GitHub is a file host, not a data source, so something still has to
compute `market_state` and push it. A scheduled GitHub Action that runs shortly
before each slot is the natural fit.

Two things change when the payload is a file rather than a live response:

**Freshness stops being automatic.** An endpoint that breaks returns an error and
the run skips. A committed file that stops being updated keeps serving the last
good payload — well-formed, internally consistent, passing every validator rule,
and describing yesterday's market. That is the worst failure this pipeline has,
because nothing downstream can see it. `check_payload.js` therefore fails when
`now_utc` is more than `--max-age` minutes behind real time (default 120). Set
the Action's schedule so a fresh commit always lands before the slot fires, and
let the staleness check be the backstop rather than the plan.

**`prior_posts` has to be written back.** Scheduled runs cannot push. Whatever
updates `payload.json` must also append to `prior_posts` after a post actually
goes out on X — including `generated_at` and `card.layout_variant`. If that write
never happens, rate limiting, variant rotation and similarity all silently
degrade to "nothing has ever been posted".

## Testing before the endpoint exists

The pipeline can be exercised end to end today by serving a static file. Take
`fixtures/payload.json`, host it at any URL the sandbox can reach, and point the
scheduled task at it. Everything downstream — generation, card render, all 20
validator rules — runs unchanged against a stub.

Validate a real response against this contract before wiring it up:

```bash
curl -s "$BASE/market_state?slot=morning_map" \
  | node tools/validator/check_payload.js --slot morning_map
```
