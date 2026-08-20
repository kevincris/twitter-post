#!/usr/bin/env node
/* Negative tests: mutate the known-good fixture one way at a time and assert
 * the intended rule fails. A validator that only ever says "ok" is decoration. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const REC = 'queue/2026-08-19_morning_map.json';
const PAY = 'fixtures/payload.json';
const HTML = 'out/2026-08-19_morning_map.html';
const PNG = 'out/2026-08-19_morning_map.png';

const goodRec = fs.readFileSync(REC, 'utf8');
const goodPay = fs.readFileSync(PAY, 'utf8');
const goodHtml = fs.readFileSync(HTML, 'utf8');
const goodPng = fs.readFileSync(PNG);

const clone = () => JSON.parse(goodRec);

const CASES = [
  ['2  unclaimed numeral in tweet', 2, (r) => {
    r.tweet.text = r.tweet.text.replace('Core PCE', 'ETF flows 7.4t, Core PCE');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['3  unresolvable source_field', 3, (r) => { r.claims[0].source_field = 'market_state.levels[9].price'; }],
  ['4  claim value differs from payload', 4, (r) => { r.claims[0].value = 3421.9; }],
  ['5  char_count lies', 5, (r) => { r.tweet.char_count = 100; }],
  ['6  trader directive', 6, (r) => {
    r.tweet.text = r.tweet.text.replace('is reference, not resistance', 'is where you buy');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['6  price target', 6, (r) => {
    r.tweet.text = r.tweet.text.replace('bracket the session', 'is the target');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['8  slot already posted today', 8, (r) => r, (p) => {
    p.prior_posts.unshift({ id: 'x', slot: 'morning_map', generated_at: '2026-08-19T23:00:00Z', text: 'z', claims: [], card: { layout_variant: 'hero-n' } });
  }],
  ['9  near-duplicate of a prior post', 9, (r) => r, (p) => {
    const t = JSON.parse(goodRec).tweet.text;
    p.prior_posts.unshift({ id: 'x', slot: 'recap', generated_at: '2026-08-18T21:00:00Z', text: t, card: { layout_variant: 'hero-n' } });
  }],
  ['10 unclaimed numeral on the card', 10, (r) => r, null, (h) => h.replace('Session map', 'Session map 88')],
  ['10 numeral smuggled in via CSS content', 10, (r) => r, null,
    (h) => h.replace('.slot {', '.slot::after { content:" 88"; }\n.slot {')],
  ['11 off-token hex in the card', 11, (r) => r, null, (h) => h.replace('opacity:0.9;', 'opacity:0.9; color:#FF0000;')],
  ['11 named colour in the card', 11, (r) => r, null, (h) => h.replace('background: var(--bp-surface);', 'background: black;')],
  ['11 tampered --bp- declaration', 11, (r) => r, null, (h) => h.replace('--bp-accent: #3B82F6;', '--bp-accent: #3b82f6;')],
  ['12 logo inlined as markup, not base64', 12, (r) => r, null,
    (h) => h.replace(/<img class="logo"[^>]*>/, '<svg width="80" height="20"><circle cx="10" cy="10" r="9" fill="#3B82F6"/></svg>')],
  ['12 logo recoloured before embedding', 12, (r) => r, null, (h) => {
    const m = h.match(/base64,([A-Za-z0-9+/=]+)/);
    const svg = Buffer.from(m[1], 'base64').toString('utf8').replace(/#3B82F6/g, '#64748B');
    return h.replace(m[1], Buffer.from(svg).toString('base64'));
  }],
  ['14 variant repeats previous post', 14, (r) => { r.card.layout_variant = 'ladder-left'; }],
  ['15 local timezone leaks into text', 15, (r) => {
    r.tweet.text = r.tweet.text.replace('12:30 UTC', '19:30 WIB');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['16 one-sided map, unflagged', 16, (r) => {
    r.tweet.text = '3,421.8 and 3,402.0 bracket it. Above 3,421.8 the prior-day high is reference. Asia ranged 3,414.0 to 3,399.5. Core PCE 12:30 UTC.';
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['17 Tier-1 vocabulary', 17, (r) => {
    r.tweet.text = r.tweet.text.replace('bracket the session', 'are the crucial levels');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['18 no digit in the hook', 18, (r) => {
    r.tweet.text = 'The session is bracketed above and below. Above 3,421.8 the prior-day high is reference; a hold below 3,402.0 puts the weekly open in control. Asia ranged 3,414.0 to 3,399.5. Core PCE 12:30 UTC.';
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['20 magnitude adjective', 20, (r) => {
    r.tweet.text = r.tweet.text.replace('Asia ranged', 'Asia moved sharply between');
    r.tweet.char_count = [...r.tweet.text].length;
  }],
  ['13 wrong render dimensions', 13, (r) => r, null, null, true],
];

let passed = 0, failed = 0;

for (const [name, wantRule, mutRec, mutPay, mutHtml, breakPng] of CASES) {
  const rec = clone();
  if (mutRec) mutRec(rec);
  const pay = JSON.parse(goodPay);
  if (mutPay) mutPay(pay);
  fs.writeFileSync(REC, JSON.stringify(rec, null, 2));
  fs.writeFileSync(PAY, JSON.stringify(pay, null, 2));
  fs.writeFileSync(HTML, mutHtml ? mutHtml(goodHtml) : goodHtml);
  if (breakPng) {
    const b = Buffer.from(goodPng); b.writeUInt32BE(1200, 16); fs.writeFileSync(PNG, b);
  } else fs.writeFileSync(PNG, goodPng);

  let out = '';
  try { out = execFileSync('node', ['tools/validator/validate.js', '--record', REC, '--payload', PAY, '--json'], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }

  let hit = false, msg = '';
  try {
    const j = JSON.parse(out);
    const f = j.results.find((x) => x.n === wantRule && x.status === 'FAIL');
    hit = Boolean(f); msg = f ? f.message : (j.results.find((x) => x.status === 'FAIL')?.n ?? 'nothing');
  } catch { msg = 'validator produced no JSON'; }

  if (hit) { passed++; console.log(`  ok    ${name}  ->  rule ${wantRule} caught it`); }
  else { failed++; console.log(`  MISS  ${name}  ->  expected rule ${wantRule}, got ${msg}`); }
}

/* ---- slot-specific rules: 7 (threshold) and 19 (pairing) ----------------
 * These are the anti-self-grading rules. The record asserts it cleared the
 * bar; the validator recomputes the bar from the payload and disagrees. */

const SLOT_CASES = [
  ['7  london_open below both thresholds but claims post', 7, (r, p) => {
    r.slot = 'london_open';
    p.slot = 'london_open';
    p.market_state.atr20 = 28.4;
    p.market_state.asia_range = { high: 3409.0, low: 3405.0 };  // 4.0 vs 9.94 needed
    p.market_state.last = 3450.0;                                // 28.2 from nearest vs 4.26 needed
  }],
  ['7  pre_event with too small a sample', 7, (r, p) => {
    r.slot = 'pre_event'; p.slot = 'pre_event';
    p.now_utc = '2026-08-20T11:30:00Z';
    p.ere = { event_key: 'us_core_pce_mom', n: 11 };
  }],
  ['7  pre_event outside the 90 minute window', 7, (r, p) => {
    r.slot = 'pre_event'; p.slot = 'pre_event';
    p.now_utc = '2026-08-20T08:00:00Z';
    p.ere = { event_key: 'us_core_pce_mom', n: 47 };
  }],
  ['19 post_event references the wrong prior post', 19, (r, p) => {
    r.slot = 'post_event';
    r.references_prior_post_id = 'wrong-id';
    p.slot = 'post_event';
    p.realized = { event_key: 'us_core_pce_mom', print: 0.4, consensus: 0.3, move_30m_abs: 14.2, percentile_vs_ere: 62, pre_event_post_id: 'pre-123' };
    p.ere = { event_key: 'us_core_pce_mom', n: 47 };
    p.prior_posts.unshift({ id: 'pre-123', slot: 'pre_event', generated_at: '2026-08-19T22:00:00Z', event_key: 'us_core_pce_mom', text: 'distribution', claims: [], card: { layout_variant: 'hero-n' } });
  }],
  ['19 percentile in text contradicts the payload', 19, (r, p) => {
    r.slot = 'post_event';
    r.references_prior_post_id = 'pre-123';
    r.tweet.text = 'Print 0.4 vs 0.3 consensus. 30m move 14.2 — 71st percentile of the n=47 history posted at 12:00 UTC.';
    r.tweet.char_count = [...r.tweet.text].length;
    p.slot = 'post_event';
    p.realized = { event_key: 'us_core_pce_mom', print: 0.4, consensus: 0.3, move_30m_abs: 14.2, percentile_vs_ere: 62, pre_event_post_id: 'pre-123' };
    p.ere = { event_key: 'us_core_pce_mom', n: 47 };
    p.prior_posts.unshift({ id: 'pre-123', slot: 'pre_event', generated_at: '2026-08-19T22:00:00Z', event_key: 'us_core_pce_mom', text: 'distribution', claims: [], card: { layout_variant: 'hero-n' } });
  }],
];

for (const [name, wantRule, mutate] of SLOT_CASES) {
  const rec = clone();
  const pay = JSON.parse(goodPay);
  mutate(rec, pay);
  fs.writeFileSync(REC, JSON.stringify(rec, null, 2));
  fs.writeFileSync(PAY, JSON.stringify(pay, null, 2));
  fs.writeFileSync(HTML, goodHtml);
  fs.writeFileSync(PNG, goodPng);

  let out = '';
  try { out = execFileSync('node', ['tools/validator/validate.js', '--record', REC, '--payload', PAY, '--json'], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }

  let hit = false, msg = '';
  try {
    const j = JSON.parse(out);
    const f = j.results.find((x) => x.n === wantRule && x.status === 'FAIL');
    hit = Boolean(f); msg = f ? f.message : (j.results.filter((x) => x.status === 'FAIL').map((x) => x.n).join(',') || 'nothing');
  } catch { msg = 'validator produced no JSON'; }

  if (hit) { passed++; console.log(`  ok    ${name}  ->  rule ${wantRule} caught it`); }
  else { failed++; console.log(`  MISS  ${name}  ->  expected rule ${wantRule}, got ${msg}`); }
}

fs.writeFileSync(REC, goodRec);
fs.writeFileSync(PAY, goodPay);
fs.writeFileSync(HTML, goodHtml);
fs.writeFileSync(PNG, goodPng);

console.log(`\n${passed} caught, ${failed} missed.`);
process.exit(failed ? 1 : 0);
