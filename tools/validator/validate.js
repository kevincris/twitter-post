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

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const recordPath = arg('--record');
  const payloadPath = arg('--payload');
  const repo = path.resolve(arg('--repo', '.'));
  const asJSON = argv.includes('--json');

  if (!recordPath || !payloadPath) {
    console.error('usage: validate.js --record <file> --payload <file> [--repo .] [--json]');
    process.exit(2);
  }

  const rec = readJSON(recordPath);
  const payload = readJSON(payloadPath);
  const prior = payload.prior_posts || [];
  const nowUtc = payload.now_utc;

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

  /* 3 — claim source_fields resolve */
  {
    const r = rule(3, 'claim source_fields resolve');
    const bad = (rec.claims || []).filter((c) => resolveField(payload, c.source_field) === undefined);
    if (!(rec.claims || []).length) r.fail('claims[] is empty but the post carries numerals');
    else if (bad.length) r.fail(`unresolvable: ${bad.map((c) => c.source_field).join(', ')}`);
    else r.pass(`${rec.claims.length} claims resolve`);
  }

  /* 4 — claim values match the payload */
  {
    const r = rule(4, 'claim values match payload');
    const bad = [];
    for (const c of rec.claims || []) {
      const actual = resolveField(payload, c.source_field);
      if (actual === undefined) continue;
      if (typeof c.value === 'number' && typeof actual === 'number') {
        if (Math.abs(actual - c.value) > FLOAT_TOL) bad.push(`${c.source_field}: claimed ${c.value}, payload ${actual}`);
      } else if (String(actual) !== String(c.value)) {
        bad.push(`${c.source_field}: claimed ${c.value}, payload ${actual}`);
      }
    }
    if (bad.length) r.fail(bad.join(' | ')); else r.pass();
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
    console.log(failed.length
      ? `\nDO NOT POST — ${failed.length} rule(s) failed.`
      : `\nOK to post${warned.length ? ` (${warned.length} warning(s) — read them)` : ''}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
