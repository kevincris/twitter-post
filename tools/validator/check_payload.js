#!/usr/bin/env node
/**
 * Payload contract check — run this against the endpoint before wiring it into
 * a scheduled task. Catches the shape problems that would otherwise surface as
 * a silent skip at 23:30 UTC.
 *
 *   curl -s "$BASE/market_state?slot=morning_map" | node tools/validator/check_payload.js --slot morning_map
 *   node tools/validator/check_payload.js --slot recap -f payload.json
 */

'use strict';
const fs = require('fs');

const problems = [];
const warnings = [];
const bad = (m) => problems.push(m);
const warn = (m) => warnings.push(m);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

function checkNum(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) { if (cur == null) break; cur = cur[p]; }
  if (!num(cur)) bad(`${path} must be a finite number (got ${JSON.stringify(cur)})`);
  return cur;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const slot = arg('--slot');
  const file = arg('-f');

  const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  let p;
  try { p = JSON.parse(raw); }
  catch (e) { console.error(`not JSON: ${e.message}`); process.exit(1); }

  if (!slot) { console.error('usage: check_payload.js --slot <morning_map|london_open|recap> [-f file]'); process.exit(2); }

  /* top level */
  if (p.slot !== slot) bad(`slot is "${p.slot}", expected "${slot}"`);
  if (!ISO.test(p.now_utc || '')) bad(`now_utc "${p.now_utc}" is not ISO 8601 Z-suffixed`);
  if (!p.instrument) bad('instrument missing');
  if (!p.session || typeof p.session.holiday !== 'boolean') {
    bad('session.holiday must be a boolean — morning_map cannot decide to skip without it');
  }

  /* market_state */
  const ms = p.market_state;
  if (!ms) bad('market_state missing — the runner will skip with payload_unavailable');
  else {
    checkNum(p, 'market_state.last');
    const atr = checkNum(p, 'market_state.atr20');
    if (num(atr) && atr <= 0) bad('market_state.atr20 must be positive');
    checkNum(p, 'market_state.asia_range.high');
    checkNum(p, 'market_state.asia_range.low');
    if (ms.asia_range && num(ms.asia_range.high) && num(ms.asia_range.low)
        && ms.asia_range.high < ms.asia_range.low) bad('asia_range.high is below asia_range.low');
    for (const k of ['high', 'low', 'close']) checkNum(p, `market_state.prior_day.${k}`);

    if (!Array.isArray(ms.levels) || !ms.levels.length) bad('market_state.levels must be a non-empty array — the post can only name levels listed here');
    else {
      ms.levels.forEach((l, i) => {
        if (!l.label || typeof l.label !== 'string') bad(`levels[${i}].label missing`);
        if (!num(l.price)) bad(`levels[${i}].price must be a number`);
        if (l.label && /_|\d{2,}/.test(l.label)) warn(`levels[${i}].label "${l.label}" will be read aloud in a sentence — prefer prose like "weekly open"`);
      });
      if (ms.levels.length > 6) warn(`${ms.levels.length} levels — long lists dilute the map; four or five is plenty`);
    }
  }

  /* calendar */
  if (!Array.isArray(p.calendar)) bad('calendar must be an array (empty is fine)');
  else p.calendar.forEach((e, i) => {
    if (!e.event) bad(`calendar[${i}].event missing`);
    if (!ISO.test(e.time_utc || '')) bad(`calendar[${i}].time_utc "${e.time_utc}" is not ISO 8601 Z-suffixed`);
    if (![1, 2, 3].includes(e.tier)) warn(`calendar[${i}].tier is ${e.tier}; tier 1 is what pre_event will key off`);
  });

  /* prior_posts — the state store */
  if (!Array.isArray(p.prior_posts)) {
    bad('prior_posts must be an array — rate limiting, variant rotation and similarity all read it');
  } else {
    if (!p.prior_posts.length) {
      warn('prior_posts is empty. If that is genuinely true, fine. If it is a stub, the generator will repeat yesterday\'s layout and framing and nothing will stop it.');
    }
    p.prior_posts.forEach((q, i) => {
      if (!ISO.test(q.generated_at || '')) bad(`prior_posts[${i}].generated_at "${q.generated_at}" is not ISO 8601 Z — rule 8 cannot compute the 2h gap without it`);
      if (!q.slot) bad(`prior_posts[${i}].slot missing`);
      if (typeof q.text !== 'string') bad(`prior_posts[${i}].text missing — rule 9 needs it for similarity`);
      if (!q.card || !q.card.layout_variant) bad(`prior_posts[${i}].card.layout_variant missing — rule 14 cannot rotate variants without it`);
    });
    const now = Date.parse(p.now_utc);
    if (Number.isFinite(now)) {
      const stale = p.prior_posts.filter((q) => Date.parse(q.generated_at) < now - 72 * 3600e3).length;
      if (stale) warn(`${stale} prior_posts entries are older than 72h — harmless, but the window is meant to be 72h`);
    }
  }

  /* slot-specific */
  if (slot === 'recap') {
    const st = p.session_today;
    if (!st) bad('session_today is required for recap — without it the grade has no payload field behind it and rule 2 fails');
    else {
      for (const k of ['high', 'low', 'last']) checkNum(p, `session_today.${k}`);
      if (!Array.isArray(st.levels_triggered) || !st.levels_triggered.length) {
        bad('session_today.levels_triggered must be a non-empty array — it is what the recap grades');
      } else st.levels_triggered.forEach((l, i) => {
        if (typeof l.triggered !== 'boolean') bad(`levels_triggered[${i}].triggered must be a boolean`);
        if (!num(l.price)) bad(`levels_triggered[${i}].price must be a number`);
        if (l.triggered && !ISO.test(l.first_touch_utc || '')) bad(`levels_triggered[${i}] is triggered but first_touch_utc is not a UTC timestamp`);
      });
    }
  } else if (p.session_today) {
    warn(`session_today is populated on a ${slot} payload; it is only read for recap`);
  }

  if (slot === 'london_open' && ms && num(ms.atr20) && ms.asia_range) {
    const range = ms.asia_range.high - ms.asia_range.low;
    const dists = (ms.levels || []).map((l) => Math.abs(ms.last - l.price)).filter(Number.isFinite);
    const nearest = dists.length ? Math.min(...dists) : Infinity;
    const fires = range >= 0.35 * ms.atr20 || nearest <= 0.15 * ms.atr20;
    warn(`threshold preview: range ${range.toFixed(2)} vs ${(0.35 * ms.atr20).toFixed(2)}, nearest level ${nearest.toFixed(2)} vs ${(0.15 * ms.atr20).toFixed(2)} → would ${fires ? 'POST' : 'SKIP'}`);
  }

  /* phase 1 */
  if (p.ere) warn('ere is populated; phase 1 ignores it and pre_event is not scheduled yet');
  if (p.realized) warn('realized is populated; phase 1 ignores it and post_event is not scheduled yet');

  for (const w of warnings) console.log(`warn  ${w}`);
  for (const b of problems) console.log(`FAIL  ${b}`);
  console.log(problems.length
    ? `\n${problems.length} problem(s) — the generator would skip or produce unclaimable numbers.`
    : `\nPayload satisfies the phase 1 contract${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
  process.exit(problems.length ? 1 : 0);
}

main();
