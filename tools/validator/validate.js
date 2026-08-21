#!/usr/bin/env node
/**
 * Bearpaws X post validator — rules 1-20 from bearpaws_runner_prompt_v2.md.
 *
 * Dependency-free. Node >= 16.
 *
 *   node tools/validator/validate.js --record queue/2026-08-19_pre_event.json \
 *                                    --payload payload.json [--repo .] [--json]
 *
 * Exit 0 = safe to post (warnings allowed). Exit 1 = do not post.
 *
 * The model does not get to grade itself. Every threshold, percentile and
 * numeral is recomputed here from the payload, never read from the record.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* ------------------------------- config ---------------------------------- */

const TOKENS = ['#0b0f19', '#3b82f6', '#e8edf7', '#64748b'];

const CANONICAL_DECLS = [
  '--bp-surface: #0B0F19;',
  '--bp-accent: #3B82F6;',
  '--bp-text: #E8EDF7;',
  '--bp-muted: #64748B;',
];

const FLOAT_TOL = 0.01;
const SIMILARITY_MAX = 0.85;
const HUMANIZER_MAX = 30;
const ATR_RANGE_MULT = 0.35;   // london_open: asia range vs ATR20
const ATR_PROX_MULT = 0.15;    // london_open: level interaction distance
const ERE_MIN_N = 20;
const PRE_EVENT_WINDOW_MIN = 90;

/* Numerals that are structural rather than data, and so need no claim.
 * Deliberately narrow — every exemption is a hole in rule 2. Exemptions are
 * listed in the report so they stay auditable. */
const STRUCTURAL_NUMERAL = [
  /\b\d+(?:m|h|d|min|hr|hrs)\b/gi,   // "30m move", "4h persistence"
  /\bATR\d+\b/gi,                    // "ATR20"
  /\b\d+[-\u2011\u2013]?(?:day|period|session|bar|week|month)s?\b/gi,  // "20-day ATR", "47 sessions"
];

const BANNED = [
  // entries, stops, targets
  [/\b(?:entry|entries)\s*(?:@|at|:)/i, 'entry level'],
  [/\b(?:stop[\s-]?loss|take[\s-]?profit|\bSL\b|\bTP\b)/i, 'stop/target'],
  [/\btarget(?:s|ing)?\b/i, 'price target'],
  // prediction
  [/\bwill\s+(?:hit|reach|break|test|go|move|rally|fall|drop)\b/i, 'prediction verb'],
  [/\b(?:heading|headed)\s+(?:to|for)\b/i, 'prediction verb'],
  // trader directives
  [/\b(?:buy|sell|go long|go short|fade|enter|exit|add|size up|size down|take profit|wait for the retrace)\b/i, 'trader directive'],
  // performance claims
  [/\b\d{1,3}(?:\.\d+)?\s*%\s*(?:win|accuracy|hit)\s*rate\b/i, 'performance claim'],
  [/\bwin\s*rate\b/i, 'performance claim'],
];

const MAGNITUDE_ADJ = /\b(?:sharp(?:ly)?|violent(?:ly)?|muted|massive|huge|big move|explosive|brutal)\b/i;

const TIER1 = [
  'delve', 'tapestry', 'landscape', 'vibrant', 'crucial', 'robust', 'seamless',
  'pivotal', 'groundbreaking', 'leverage', 'transformative', 'paramount',
  'showcase', 'unpack', 'deep dive', 'actionable', 'impactful', 'realm',
  'myriad', 'cornerstone', 'testament', 'evolving', 'reshaping',
];

const FILLER = ['in order to', 'due to the fact that', "it's worth noting", 'it is worth noting'];

const NAMED_COLORS = [
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray',
  'grey', 'silver', 'navy', 'teal', 'lime', 'aqua', 'fuchsia', 'maroon', 'olive',
  'crimson', 'gold', 'pink', 'brown', 'cyan', 'magenta', 'beige', 'ivory',
];

/* ------------------------------ reporting -------------------------------- */


/* ---- claim sources -------------------------------------------------------
 * v3: a claim's provenance is a tagged source, not only a payload dot-path.
 *   payload  — { kind:'payload',  field:'market_state.last' }
 *   web      — { kind:'web',      url, retrieved_at, quoted_text }
 *   computed — { kind:'computed', method, inputs:[numbers] }
 * The legacy `source_field` string is still accepted and read as payload.
 * The point is unchanged: every numeral must be re-checkable by machine. */

const SOURCE_KINDS = ['payload', 'web', 'computed'];
const COMPUTE = {
  mean: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  /* atr: inputs are raw bars, not pre-computed true ranges. Accepting TRs
   * would mean trusting twenty numbers nobody can trace; accepting bars lets
   * the validator recompute the ranges AND check each bar against a snapshot. */
  atr: (xs, src) => {
    const bars = src.bars || [];
    let prev = src.prev_close;
    const trs = [];
    for (const b of bars) {
      const hl = b.high - b.low;
      const tr = Number.isFinite(prev) ? Math.max(hl, Math.abs(b.high - prev), Math.abs(b.low - prev)) : hl;
      trs.push(tr);
      prev = b.close;
    }
    return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : NaN;
  },
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  subtract: (xs) => xs.reduce((a, b) => a - b),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
};

function claimSource(c) {
  if (c && typeof c.source_field === 'string') return { kind: 'payload', field: c.source_field };
  return (c && c.source) || null;
}

/* Does `value` actually appear in the quoted snippet? Tolerates thousands
 * separators and trailing zeros, so 3412.4 matches "3,412.40". */
function quoteNumbers(quote) {
  const norm = String(quote).replace(/[,\u00A0\u202F]/g, '');
  return (norm.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

/* Match on magnitude. Tweets carry direction in words ("down 0.67%"), not in
 * the numeral, so a claim of 0.67 sourced from "-0.67%" is normal. The sign
 * is not ignored though — signMismatch below reports it separately, because
 * "up 0.67%" off a "-0.67%" quote is exactly the error that ends an account
 * built on checkable numbers. */
function valueInQuote(value, quote) {
  if (typeof value !== 'number') return String(quote).includes(String(value));
  return quoteNumbers(quote).some((n) => Math.abs(Math.abs(n) - Math.abs(value)) <= FLOAT_TOL);
}

function signMismatch(value, quote) {
  if (typeof value !== 'number' || value === 0) return false;
  const hit = quoteNumbers(quote).find((n) => Math.abs(Math.abs(n) - Math.abs(value)) <= FLOAT_TOL);
  return hit !== undefined && hit !== 0 && Math.sign(hit) !== Math.sign(value);
}

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let lib;
    try { lib = url.startsWith('http://') ? require('http') : require('https'); }
    catch { return resolve(null); }
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'bearpaws-validator' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/* Strip tags and collapse whitespace so a quote lifted from rendered text
 * still matches the raw HTML it came from. */
const flatten = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/[,\u00A0\u202F]/g, '').replace(/\s+/g, ' ').trim();

const results = [];
const rule = (n, title) => ({
  pass: (m) => results.push({ n, title, status: 'pass', message: m || '' }),
  fail: (m) => results.push({ n, title, status: 'FAIL', message: m }),
  warn: (m) => results.push({ n, title, status: 'warn', message: m }),
  skip: (m) => results.push({ n, title, status: 'skip', message: m }),
});

/* ------------------------------- helpers --------------------------------- */

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`cannot read JSON at ${p}: ${e.message}`); process.exit(2); }
}

/** Resolve "market_state.levels[1].price" against the payload. */
function resolveField(obj, dotted) {
  const parts = String(dotted).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Numerals in a string, with structural ones removed. Returns {kept, exempt}. */
function extractNumerals(text) {
  let masked = String(text);
  const exempt = [];
  for (const re of STRUCTURAL_NUMERAL) {
    masked = masked.replace(re, (m) => { exempt.push(m); return ' '.repeat(m.length); });
  }
  masked = masked.replace(/https?:\/\/\S+/g, ' ');   // URLs carry no claims
  const kept = [];
  for (const m of masked.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = parseFloat(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) kept.push({ raw: m[0], value: v });
  }
  return { kept, exempt };
}

/** Every number a claim licenses. ISO timestamps license their UTC HH and MM. */
function claimedValues(claims) {
  const out = [];
  for (const c of claims || []) {
    if (typeof c.value === 'number') out.push(c.value);
    if (typeof c.value === 'string') {
      const iso = c.value.match(/T(\d{2}):(\d{2})/);
      if (iso) {
        out.push(parseInt(iso[1], 10), parseInt(iso[2], 10));
        out.push(parseInt(iso[1] + iso[2], 10));
      }
      const n = parseFloat(c.value.replace(/,/g, ''));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

const licensed = (v, pool) => pool.some((p) => Math.abs(p - v) <= FLOAT_TOL);

/** Strip base64 data URIs so the logo's own bytes never reach the color scan. */
const stripDataURIs = (html) => html.replace(/data:[^;,]+;base64,[A-Za-z0-9+/=]+/g, 'DATA_URI');

function htmlNumeralSources(html) {
  const body = stripDataURIs(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const texts = [];
  for (const m of body.matchAll(/>([^<]+)</g)) texts.push(m[1]);
  for (const m of body.matchAll(/data-value\s*=\s*"([^"]*)"/gi)) texts.push(m[1]);
  /* CSS `content:` can paint numerals onto the card that never appear in the
   * markup. Anything a reader can screenshot has to be claimable, so the
   * stylesheet's generated content is scanned too. */
  const styles = stripDataURIs(html).match(/<style\b[\s\S]*?<\/style>/gi) || [];
  for (const block of styles) {
    for (const m of block.matchAll(/content\s*:\s*(["'])([\s\S]*?)\1/gi)) texts.push(m[2]);
  }
  return texts.join(' ');
}

function pngInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let idat = 0, off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat += len;
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return { width, height, idat, bytes: buf.length };
}

function cosine(a, b) {
  const tok = (s) => String(s).toLowerCase().match(/[a-z0-9.,]+/g) || [];
  const bag = (s) => tok(s).reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
  const A = bag(a), B = bag(b);
  let dot = 0, na = 0, nb = 0;
  for (const k of Object.keys(A)) { na += A[k] ** 2; if (B[k]) dot += A[k] * B[k]; }
  for (const k of Object.keys(B)) nb += B[k] ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const allItems = (rec) => [rec.tweet?.text || '', ...(rec.tweet?.thread || [])].filter(Boolean);
const dayOf = (iso) => String(iso).slice(0, 10);

/* --------------------------------- main ---------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const recordPath = arg('--record');
  const payloadPath = arg('--payload');
  const repo = path.resolve(arg('--repo', '.'));
  const asJSON = argv.includes('--json');
  const verifySources = argv.includes('--verify-sources');

  if (!recordPath) {
    console.error('usage: validate.js --record <file> [--payload <file>] [--repo .] [--verify-sources] [--json]');
    console.error('  --payload is optional in v3: a run that researches its own numbers has none.');
    process.exit(2);
  }

  const rec = readJSON(recordPath);
  const hasPayload = Boolean(payloadPath);
  const payload = hasPayload ? readJSON(payloadPath) : {};

  /* prior_posts is the state store for rules 8, 9 and 14. It rides in the
   * payload when there is one; otherwise reconstruct it from committed
   * records in queue/, which is all a fresh container can see. */
  let prior = payload.prior_posts;
  if (!prior) {
    prior = [];
    const qdir = path.join(repo, 'queue');
    if (fs.existsSync(qdir)) {
      for (const f of fs.readdirSync(qdir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const q = JSON.parse(fs.readFileSync(path.join(qdir, f), 'utf8'));
          if (q.post === true && path.resolve(qdir, f) !== path.resolve(recordPath)) {
            prior.push({ id: q.id || f, slot: q.slot, generated_at: q.generated_at,
                         text: q.tweet?.text || '', claims: q.claims || [], card: q.card || {} });
          }
        } catch { /* a malformed queue file is not this run's problem */ }
      }
    }
  }
  const nowUtc = payload.now_utc || rec.generated_at;

  /* A skip record is a different object with different obligations. */
  if (rec.post !== true) {
    const r = rule(0, 'skip record shape');
    if (!rec.skip_reason) r.fail('post is not true but skip_reason is missing');
    else if (rec.tweet || rec.card) r.fail('skip record must omit tweet and card');
    else r.pass(`skip: ${rec.skip_reason}`);
    return report(results, asJSON);
  }

  const items = allItems(rec);
  const joined = items.join('\n');
  const pool = claimedValues(rec.claims);
  const flags = rec.risk_flags || [];

  /* 1 — post true, text non-empty */
  {
    const r = rule(1, 'post true and text non-empty');
    if (!rec.tweet || !String(rec.tweet.text || '').trim()) r.fail('tweet.text is empty');
    else r.pass();
  }

  /* 2 — every numeral in text + thread is claimed */
  {
    const r = rule(2, 'tweet numerals are claimed');
    const bad = [], exempted = [];
    for (const it of items) {
      const { kept, exempt } = extractNumerals(it);
      exempted.push(...exempt);
      for (const num of kept) if (!licensed(num.value, pool)) bad.push(num.raw);
    }
    if (bad.length) r.fail(`unclaimed numerals: ${[...new Set(bad)].join(', ')}`);
    else r.pass(exempted.length ? `ok (structural, unclaimed by design: ${[...new Set(exempted)].join(', ')})` : 'ok');
  }

  /* 3 — every claim carries a well-formed, resolvable source */
  {
    const r = rule(3, 'claim sources are well-formed');
    const claims = rec.claims || [];
    const bad = [];
    for (const c of claims) {
      const src = claimSource(c);
      const tag = c.assertion || JSON.stringify(c.value);
      if (!src || !src.kind) { bad.push(`${tag}: no source`); continue; }
      if (!SOURCE_KINDS.includes(src.kind)) { bad.push(`${tag}: unknown source kind "${src.kind}"`); continue; }
      if (src.kind === 'payload') {
        if (!hasPayload) bad.push(`${tag}: payload source but no --payload given`);
        else if (resolveField(payload, src.field) === undefined) bad.push(`${tag}: unresolvable ${src.field}`);
      } else if (src.kind === 'web') {
        if (!/^https?:\/\//.test(src.url || '')) bad.push(`${tag}: web source needs an http(s) url`);
        if (!src.quoted_text) bad.push(`${tag}: web source needs quoted_text — a URL alone is not checkable`);
        if (!src.snapshot) bad.push(`${tag}: web source needs a snapshot path — the validator has no network and cannot re-fetch`);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(src.retrieved_at || '')) bad.push(`${tag}: web source needs retrieved_at as ISO 8601 Z`);
      } else {
        if (!COMPUTE[src.method]) bad.push(`${tag}: computed source needs method in ${Object.keys(COMPUTE).join('|')}`);
        if (src.method === 'atr') {
          if (!Array.isArray(src.bars) || src.bars.length < 2 || src.bars.some((b) => !b || ![b.high, b.low, b.close].every(Number.isFinite))) {
            bad.push(`${tag}: atr needs bars[] of {high, low, close}, not pre-computed true ranges`);
          }
        } else if (!Array.isArray(src.inputs) || !src.inputs.length || src.inputs.some((x) => typeof x !== 'number')) {
          bad.push(`${tag}: computed source needs a non-empty numeric inputs[]`);
        }
        /* Inputs must be traceable or `computed` becomes a laundering channel:
         * any number at all can be produced by naming an arithmetic that
         * yields it, and the validator would confirm the arithmetic while
         * knowing nothing about where the operands came from. */
        if (!src.derived_from) bad.push(`${tag}: computed source needs derived_from — a snapshot its inputs can be traced to`);

        /* A sampled figure is not the thing it approximates. The min and max of
         * 32 delayed snapshots is not a session high and low, and publishing it
         * as one is a false label on a checkable number. */
        if (src.sampled) {
          if (!src.window || !src.window.from || !src.window.to) bad.push(`${tag}: sampled source needs window {from, to} in UTC`);
          if (!Number.isFinite(src.n)) bad.push(`${tag}: sampled source needs n, the sample count`);
          else if (Array.isArray(src.inputs) && src.n !== src.inputs.length) {
            bad.push(`${tag}: sampled source says n=${src.n} but carries ${src.inputs.length} inputs`);
          }
        }
      }
    }
    if (!claims.length) r.fail('claims[] is empty but the post carries numerals');
    else if (bad.length) r.fail(bad.join(' | '));
    else {
      const by = claims.reduce((a, c) => { const k = claimSource(c).kind; a[k] = (a[k] || 0) + 1; return a; }, {});
      r.pass(Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', '));
    }
  }

  /* 4 — claim values match their source */
  {
    const r = rule(4, 'claim values match their source');
    const bad = [], signFlips = [];
    for (const c of rec.claims || []) {
      const src = claimSource(c);
      if (!src || !src.kind) continue;
      const tag = c.assertion || String(c.value);

      if (src.kind === 'payload') {
        const actual = resolveField(payload, src.field);
        if (actual === undefined) continue;
        if (typeof c.value === 'number' && typeof actual === 'number') {
          if (Math.abs(actual - c.value) > FLOAT_TOL) bad.push(`${src.field}: claimed ${c.value}, payload ${actual}`);
        } else if (String(actual) !== String(c.value)) {
          bad.push(`${src.field}: claimed ${c.value}, payload ${actual}`);
        }

      } else if (src.kind === 'web') {
        /* Offline half of the web check: the number must at least appear in
         * the snippet the writer says it read. Catches a value quietly
         * drifting from its own quote. Rule 21 does the online half. */
        if (!valueInQuote(c.value, src.quoted_text)) {
          bad.push(`${tag}: ${c.value} does not appear in its own quoted_text ("${String(src.quoted_text).slice(0, 60)}")`);
        } else if (signMismatch(c.value, src.quoted_text)) {
          signFlips.push(`${tag}: claimed ${c.value} but the source reads "${String(src.quoted_text).slice(0, 40)}" — check the direction word in the text`);
        }

      } else if (src.kind === 'computed') {
        const got = COMPUTE[src.method](src.inputs, src);
        if (!Number.isFinite(got) || Math.abs(got - c.value) > FLOAT_TOL) {
          bad.push(`${tag}: ${src.method} of ${src.inputs.length} inputs is ${Number(got).toFixed(4)}, claimed ${c.value}`);
        }
      }
    }
    if (bad.length) r.fail(bad.join(' | '));
    else if (signFlips.length) r.warn(`MANUAL REVIEW — ${signFlips.join(' | ')}`);
    else r.pass();
  }

  /* 5 — char_count accurate, every item <= 280 */
  {
    const r = rule(5, 'char counts');
    const bad = [];
    const actual = [...(rec.tweet.text || '')].length;
    if (rec.tweet.char_count !== actual) bad.push(`char_count says ${rec.tweet.char_count}, actual ${actual}`);
    items.forEach((it, i) => {
      const len = [...it].length;
      if (len > 280) bad.push(`item ${i} is ${len} chars`);
    });
    if (bad.length) r.fail(bad.join(' | ')); else r.pass();
  }

  /* 6 — banned tokens */
  {
    const r = rule(6, 'no banned tokens');
    const hits = BANNED.filter(([re]) => re.test(joined)).map(([, label]) => label);
    if (hits.length) r.fail(`matched: ${[...new Set(hits)].join(', ')}`); else r.pass();
  }

  /* 7 — slot threshold recomputed from the payload, not trusted */
  {
    const r = rule(7, 'slot threshold recomputed');
    const ms = payload.market_state || {};
    const slot = rec.slot;
    let ok = null, why = '';
    if (slot === 'morning_map') {
      ok = !(payload.session && payload.session.holiday);
      why = ok ? 'trading session' : 'holiday / no liquidity';
    } else if (slot === 'london_open') {
      const atr = ms.atr20;
      const range = ms.asia_range ? ms.asia_range.high - ms.asia_range.low : null;
      const dists = (ms.levels || []).map((l) => Math.abs(ms.last - l.price));
      const nearest = dists.length ? Math.min(...dists) : Infinity;
      const wide = atr && range !== null && range >= ATR_RANGE_MULT * atr;
      const near = atr && nearest <= ATR_PROX_MULT * atr;
      ok = Boolean(wide || near);
      why = `range ${range} vs ${(ATR_RANGE_MULT * atr).toFixed(2)}; nearest level ${nearest.toFixed(2)} vs ${(ATR_PROX_MULT * atr).toFixed(2)}`;
    } else if (slot === 'pre_event') {
      const t1 = (payload.calendar || []).filter((e) => e.tier === 1);
      const inWin = t1.some((e) => {
        const mins = (Date.parse(e.time_utc) - Date.parse(nowUtc)) / 60000;
        return mins > 0 && mins <= PRE_EVENT_WINDOW_MIN;
      });
      const n = payload.ere?.n ?? 0;
      ok = inWin && n >= ERE_MIN_N;
      why = `tier-1 in window: ${inWin}; ere.n = ${n}`;
    } else if (slot === 'post_event') {
      ok = Boolean(payload.realized);
      why = `realized block present: ${ok}`;
    } else if (slot === 'recap') {
      const today = dayOf(nowUtc);
      ok = prior.some((p) => dayOf(p.generated_at || today) === today && (p.claims || []).length);
      why = `checkable claims posted today: ${ok}`;
    }
    if (ok === null) r.warn(`unknown slot ${slot}`);
    else if (!ok) r.fail(`threshold not met (${why}) but the record says post`);
    else r.pass(why);
  }

  /* 8 — rate limit */
  {
    const r = rule(8, 'rate limit');
    const today = dayOf(nowUtc);
    const sameSlot = prior.filter((p) => p.slot === rec.slot && dayOf(p.generated_at || '') === today);
    const paired = rec.slot === 'post_event';
    let last2h = null;
    for (const p of prior) {
      if (!p.generated_at) continue;
      const mins = (Date.parse(nowUtc) - Date.parse(p.generated_at)) / 60000;
      if (mins >= 0 && mins < 120) last2h = p;
    }
    if (sameSlot.length) r.fail(`${rec.slot} already posted today`);
    else if (last2h && !(paired && last2h.slot === 'pre_event')) r.fail(`post within 2h of ${last2h.slot}`);
    else r.pass();
  }

  /* 9 — similarity vs last 72h */
  {
    const r = rule(9, 'similarity vs last 72h');
    let worst = 0, which = null;
    for (const p of prior) {
      const s = cosine(joined, p.text || '');
      if (s > worst) { worst = s; which = p.slot; }
    }
    if (worst >= SIMILARITY_MAX) r.fail(`cosine ${worst.toFixed(3)} vs ${which} exceeds ${SIMILARITY_MAX}`);
    else r.pass(`max cosine ${worst.toFixed(3)}`);
  }

  /* 10 — card numerals are claimed */
  {
    const r = rule(10, 'card numerals are claimed');
    const html = rec.card?.html_path && fs.existsSync(path.resolve(repo, rec.card.html_path))
      ? fs.readFileSync(path.resolve(repo, rec.card.html_path), 'utf8') : null;
    if (!html) r.fail(`card.html_path missing or unreadable: ${rec.card?.html_path}`);
    else {
      const { kept, exempt } = extractNumerals(htmlNumeralSources(html));
      const bad = kept.filter((n) => !licensed(n.value, pool)).map((n) => n.raw);
      if (bad.length) r.fail(`unclaimed on card: ${[...new Set(bad)].join(', ')}`);
      else r.pass(exempt.length ? `ok (structural: ${[...new Set(exempt)].join(', ')})` : 'ok');
    }
  }

  /* 11 — card color tokens */
  {
    const r = rule(11, 'card color tokens');
    const p = rec.card?.html_path ? path.resolve(repo, rec.card.html_path) : null;
    if (!p || !fs.existsSync(p)) r.skip('no card html');
    else {
      const raw = fs.readFileSync(p, 'utf8');
      const scan = stripDataURIs(raw);
      const bad = [];
      for (const m of scan.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (!TOKENS.includes(m[0].toLowerCase())) bad.push(m[0]);
      }
      for (const m of scan.matchAll(/\b(?:rgba?|hsla?)\s*\(/gi)) bad.push(m[0].trim());
      const styleish = scan.match(/(?:color|background|fill|stroke|border[a-z-]*)\s*:\s*([a-z]+)\s*[;}"']/gi) || [];
      for (const decl of styleish) {
        const word = decl.split(':')[1].replace(/[^a-z]/gi, '').toLowerCase();
        if (NAMED_COLORS.includes(word)) bad.push(word);
      }
      const missing = CANONICAL_DECLS.filter((d) => !raw.includes(d));
      if (bad.length) r.fail(`off-token color literals: ${[...new Set(bad)].join(', ')}`);
      else if (missing.length) r.fail(`--bp-* declarations not byte-identical, missing: ${missing.join(' ')}`);
      else r.pass();
    }
  }

  /* 12 — logo integrity */
  {
    const r = rule(12, 'logo integrity');
    const asset = rec.card?.logo_asset ? path.resolve(repo, rec.card.logo_asset) : null;
    const htmlPath = rec.card?.html_path ? path.resolve(repo, rec.card.html_path) : null;
    if (flags.includes('logo_asset_missing')) {
      if (asset && fs.existsSync(asset)) r.fail('flagged logo_asset_missing but the asset exists');
      else r.pass('flagged missing, consistent');
    } else if (!asset || !fs.existsSync(asset)) {
      r.fail(`logo_asset not found: ${rec.card?.logo_asset}`);
    } else if (!htmlPath || !fs.existsSync(htmlPath)) {
      r.fail('cannot verify embed, card html missing');
    } else {
      const want = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
      const html = fs.readFileSync(htmlPath, 'utf8');
      let matched = false;
      for (const m of html.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)) {
        const got = crypto.createHash('sha256').update(Buffer.from(m[1], 'base64')).digest('hex');
        if (got === want) { matched = true; break; }
      }
      if (matched) r.pass('embedded bytes hash-identical to asset');
      else r.fail('no base64 embed in the card matches the logo asset hash (recolored, re-exported, or inlined as markup)');
    }
  }

  /* 13 — render check */
  {
    const r = rule(13, 'render check');
    const p = rec.card?.png_path ? path.resolve(repo, rec.card.png_path) : null;
    if (!p || !fs.existsSync(p)) r.fail(`png missing: ${rec.card?.png_path}`);
    else {
      const info = pngInfo(p);
      if (!info) r.fail('not a valid PNG');
      else {
        const okDims = (info.width === 1600 && info.height === 900) || (info.width === 3200 && info.height === 1800);
        if (!okDims) r.fail(`dimensions ${info.width}x${info.height}, expected 1600x900 or 3200x1800`);
        else if (info.idat < 5000) r.fail(`image looks blank (${info.idat} compressed bytes)`);
        else r.pass(`${info.width}x${info.height}, ${Math.round(info.bytes / 1024)}KB`);
      }
    }
  }

  /* 14 — variant rotation */
  {
    const r = rule(14, 'variant rotation');
    const v = rec.card?.layout_variant;
    const prevSameSlot = prior.filter((p) => p.slot === rec.slot)[0];
    const prevAny = prior[0];
    if (!v) r.fail('card.layout_variant missing');
    else if (prevSameSlot && prevSameSlot.card?.layout_variant === v) r.fail(`variant "${v}" repeats the last ${rec.slot}`);
    else if (prevAny && prevAny.card?.layout_variant === v) r.fail(`variant "${v}" repeats the immediately preceding post`);
    else r.pass(v);
  }

  /* 15 — timestamps are UTC */
  {
    const r = rule(15, 'timestamps are UTC');
    const bad = [];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(rec.generated_at || '')) {
      bad.push(`generated_at "${rec.generated_at}" is not ISO 8601 Z`);
    }
    const surfaces = joined + JSON.stringify(rec.card || {});
    if (/\bWIB\b|\bET\b|\+07:?00/.test(surfaces)) bad.push('local-zone string present in tweet or card');
    if (bad.length) r.fail(bad.join(' | ')); else r.pass();
  }

  /* 16 — scenario map two-sidedness (heuristic, warn) */
  {
    const r = rule(16, 'scenario map two-sidedness');
    const up = /\b(?:above|over|through|breaks?)\s+[\d,]/i.test(joined);
    const down = /\b(?:below|under|holds?\s+below|loses?)\s+[\d,]/i.test(joined);
    if (up && down) r.pass('two-sided');
    else if (!up && !down) r.warn('no conditional level construction detected');
    else if (flags.includes('one_sided_map')) r.warn('one-sided, correctly flagged — needs manual review');
    else r.fail('one-sided map without risk_flag "one_sided_map"');
  }

  /* 17 — humanizer gate, recomputed */
  {
    const r = rule(17, 'humanizer gate');
    const cli = path.resolve(repo, 'tools/humanizer/cli.js');
    const local = [];
    for (const t of TIER1) if (new RegExp(`\\b${t}\\b`, 'i').test(joined)) local.push(t);
    for (const f of FILLER) if (joined.toLowerCase().includes(f)) local.push(f);
    for (const it of items) if ((it.match(/—/g) || []).length > 1) local.push('multiple em dashes in one item');
    if (/[‘’“”]/.test(joined)) local.push('curly quotes');

    if (local.length) { r.fail(`pattern hits: ${[...new Set(local)].join(', ')}`); }
    else if (!fs.existsSync(cli)) {
      if (flags.includes('humanizer_cli_missing')) r.warn('CLI absent, correctly flagged');
      else r.fail('CLI absent and risk_flag "humanizer_cli_missing" not set');
    } else {
      let score = null;
      try { score = parseInt(execFileSync('node', [cli, 'score'], { input: joined, encoding: 'utf8' }).trim(), 10); }
      catch (e) { score = parseInt(String(e.stdout || '').trim(), 10); }
      if (!Number.isFinite(score)) r.fail('could not read a score from the humanizer CLI');
      else if (score >= HUMANIZER_MAX) r.fail(`score ${score} >= ${HUMANIZER_MAX}`);
      else {
        if (rec.humanizer_score !== score) r.warn(`recomputed ${score}, record claimed ${rec.humanizer_score}`);
        else r.pass(`score ${score}`);
      }
    }
  }

  /* 18 — hook rule */
  {
    const r = rule(18, 'hook contains a digit in first 40 chars');
    const heads = [rec.tweet.text, ...(rec.tweet.thread || []).slice(0, 1)].filter(Boolean);
    const bad = heads.filter((h) => !/\d/.test([...h].slice(0, 40).join('')));
    if (bad.length) r.fail(`no digit in first 40 chars of ${bad.length} item(s)`); else r.pass();
  }

  /* 19 — post_event pairing */
  {
    const r = rule(19, 'post_event pairing');
    if (rec.slot !== 'post_event') r.skip('not a post_event');
    else {
      const realized = payload.realized || {};
      const today = dayOf(nowUtc);
      const pre = prior.find((p) => p.slot === 'pre_event' && dayOf(p.generated_at || '') === today
        && (p.event_key || payload.ere?.event_key) === realized.event_key);
      const bad = [];
      if (!pre) bad.push('no matching pre_event in today\'s prior_posts');
      if (rec.references_prior_post_id !== realized.pre_event_post_id) {
        bad.push(`references_prior_post_id ${rec.references_prior_post_id} != realized.pre_event_post_id ${realized.pre_event_post_id}`);
      }
      const pctInText = [...joined.matchAll(/(\d{1,3})(?:st|nd|rd|th)\s+percentile/gi)].map((m) => parseInt(m[1], 10));
      if (pctInText.length && pctInText.some((p) => p !== realized.percentile_vs_ere)) {
        bad.push(`percentile in text ${pctInText.join(',')} != realized.percentile_vs_ere ${realized.percentile_vs_ere}`);
      }
      if (bad.length) r.fail(bad.join(' | ')); else r.pass();
    }
  }

  /* 20 — magnitude adjectives */
  {
    const r = rule(20, 'no magnitude adjectives');
    const m = joined.match(MAGNITUDE_ADJ);
    if (m) r.fail(`"${m[0]}" — use a percentile instead`); else r.pass();
  }

  /* 21 — web claims verify against the snapshot the run saved.
   * The validator has no outbound network, so re-fetching is impossible.
   * Instead each run writes the page text it actually read to snapshots/ and
   * the quote is checked against that. This cannot prove the snapshot is a
   * faithful copy of the live page, but it does prove the writer did not
   * invent a quote after the fact, which is the failure that matters. */
  {
    const r = rule(21, 'quotes and operands trace to snapshots');
    const webClaims = (rec.claims || []).filter((c) => (claimSource(c) || {}).kind === 'web');
    const compClaims = (rec.claims || []).filter((c) => (claimSource(c) || {}).kind === 'computed');
    if (!webClaims.length && !compClaims.length) r.skip('no web or computed claims');
    else {
      const bad = [];
      const snaps = new Map();
      const loadSnap = (rel, tag) => {
        if (!rel) { bad.push(`${tag}: no snapshot path`); return undefined; }
        const abs = path.resolve(repo, rel);
        if (!abs.startsWith(path.resolve(repo))) { bad.push(`${tag}: snapshot path escapes the repo`); return undefined; }
        if (!snaps.has(abs)) snaps.set(abs, fs.existsSync(abs) ? flatten(fs.readFileSync(abs, 'utf8')) : null);
        const body = snaps.get(abs);
        if (body === null) { bad.push(`${tag}: snapshot missing at ${rel}`); return undefined; }
        return body;
      };

      /* Every operand of a computed claim must be findable in the snapshot it
       * was derived from. Without this the arithmetic checks out and the
       * numbers underneath it are whatever the writer typed. */
      for (const c of compClaims) {
        const src = claimSource(c);
        const tag = c.assertion || String(c.value);
        const body = loadSnap(src.derived_from, tag);
        if (body === undefined) continue;
        const operands = src.method === 'atr'
          ? (src.bars || []).flatMap((b) => [b.high, b.low, b.close])
          : (src.inputs || []);
        const missing = operands.filter((n) => !valueInQuote(n, body));
        if (missing.length) {
          bad.push(`${tag}: ${missing.length}/${operands.length} operands absent from ${src.derived_from} (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}) — the arithmetic is right but the inputs are untraceable`);
        }
      }
      for (const c of webClaims) {
        const src = claimSource(c);
        const tag = c.assertion || String(c.value);
        const body = loadSnap(src.snapshot, tag);
        if (body === undefined) continue;
        if (!body.includes(flatten(src.quoted_text))) {
          const stillThere = valueInQuote(c.value, body);
          bad.push(`${tag}: quote absent from its own snapshot${stillThere ? ' (value is present — the quote was reworded, restate it verbatim)' : ' and so is the value — this number is unsourced'}`);
        }
      }
      if (bad.length) r.fail(bad.join(' | '));
      else r.pass(`${webClaims.length} quote(s) and ${compClaims.length} computed claim(s) traced to ${snaps.size} snapshot(s)`);
    }
  }

  /* 22 — researched prices go stale fast */
  {
    const r = rule(22, 'web sources are fresh');
    const webClaims = (rec.claims || []).filter((c) => (claimSource(c) || {}).kind === 'web');
    const gen = Date.parse(rec.generated_at);
    if (!webClaims.length || !Number.isFinite(gen)) r.skip('no web-sourced claims');
    else {
      const stale = webClaims
        .map((c) => ({ c, min: (gen - Date.parse(claimSource(c).retrieved_at)) / 60000 }))
        .filter((x) => Number.isFinite(x.min) && x.min > 120);
      if (stale.length) r.warn(`${stale.map((x) => `${x.c.assertion || x.c.value} read ${Math.round(x.min)} min before publishing`).join('; ')}`);
      else r.pass();
    }
  }

  /* 23 — sampled figures are disclosed as sampled */
  {
    const r = rule(23, 'sampled figures disclose their sampling');
    const sampled = (rec.claims || []).filter((c) => (claimSource(c) || {}).sampled === true);
    if (!sampled.length) r.skip('nothing sampled');
    else {
      const problems = [];
      const disclosed = /\bsampl|\bn\s*=\s*\d+|\d+\s*-?\s*min(?:ute)?\b/i.test(joined);
      if (!disclosed) {
        problems.push(`the post publishes ${sampled.length} sampled figure(s) but never says so — a reader takes "Asia range" to mean the session high and low, not the extremes of ${sampled[0] && claimSource(sampled[0]).n} delayed snapshots`);
      }
      /* The count has to be visible, not just present in the JSON. */
      const counts = [...new Set(sampled.map((c) => claimSource(c).n))].filter(Number.isFinite);
      for (const n of counts) {
        if (!new RegExp(`\\b${n}\\b`).test(joined)) problems.push(`sample count n=${n} does not appear in the text or thread`);
      }
      if (problems.length) r.fail(problems.join(' | '));
      else r.pass(`${sampled.length} sampled figure(s), disclosed`);
    }
  }

  report(results, asJSON);
}

function report(res, asJSON) {
  const failed = res.filter((r) => r.status === 'FAIL');
  const warned = res.filter((r) => r.status === 'warn');
  if (asJSON) {
    console.log(JSON.stringify({ ok: !failed.length, failed: failed.length, warned: warned.length, results: res }, null, 2));
  } else {
    for (const r of res) {
      const mark = r.status === 'pass' ? 'ok  ' : r.status === 'FAIL' ? 'FAIL' : r.status === 'warn' ? 'warn' : 'skip';
      console.log(`[${mark}] ${String(r.n).padStart(2)}. ${r.title}${r.message ? ' — ' + r.message : ''}`);
    }
    const review = res.some((r) => r.status === 'warn' && /MANUAL REVIEW/.test(r.message || ''));
    console.log(failed.length
      ? `\nDO NOT POST — ${failed.length} rule(s) failed.`
      : review
        ? `\nMANUAL REVIEW REQUIRED — a number could not be verified against its source.\nDo not post until you have checked it yourself.`
        : `\nOK to post${warned.length ? ` (${warned.length} warning(s) — read them)` : ''}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
