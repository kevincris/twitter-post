#!/usr/bin/env node
/**
 * Humanizer CLI — vendored, dependency-free implementation of the
 * "Humanizer: remove AI writing patterns (v2.2)" analyzer.
 *
 * Score: 0–100, higher = more AI-like.
 * Tuned so short desk-style posts (tweets) are judged on pattern hits;
 * statistical tells (burstiness, TTR, trigrams) only engage on longer prose,
 * since they are meaningless at 280 characters.
 *
 * Usage:
 *   echo "text" | node cli.js score
 *   node cli.js score -f draft.md
 *   node cli.js analyze -f draft.md          # full report
 *   node cli.js analyze --json < input.txt   # JSON for the validator
 *   node cli.js stats -f essay.txt
 *   node cli.js suggest -f essay.txt
 *   node cli.js humanize --autofix -f a.txt  # applies safe replacements
 */

'use strict';
const fs = require('fs');

/* ---------------------------- word/phrase lists --------------------------- */

const TIER1 = [
  'delve', 'delves', 'delving', 'tapestry', 'vibrant', 'crucial', 'comprehensive',
  'meticulous', 'meticulously', 'embark', 'embarked', 'robust', 'seamless',
  'seamlessly', 'groundbreaking', 'leverage', 'leveraging', 'synergy',
  'transformative', 'paramount', 'multifaceted', 'myriad', 'cornerstone',
  'reimagine', 'reimagining', 'empower', 'empowering', 'catalyst', 'invaluable',
  'bustling', 'nestled', 'realm', 'unpack', 'unpacking', 'actionable',
  'impactful', 'learnings', 'bandwidth', 'net-net', 'value-add', 'pivotal',
  'showcase', 'showcasing', 'elevate', 'elevating', 'boast', 'boasts',
  'boasting', 'testament', 'landscape', 'breathtaking', 'stunning', 'renowned',
];

const TIER2 = [
  'furthermore', 'moreover', 'paradigm', 'holistic', 'utilize', 'utilizing',
  'facilitate', 'facilitating', 'nuanced', 'illuminate', 'illuminating',
  'encompasses', 'encompassing', 'catalyze', 'proactive', 'ubiquitous',
  'quintessential', 'cadence', 'underscore', 'underscores', 'underscoring',
  'highlight', 'highlighting', 'foster', 'fostering', 'evolving', 'reshaping',
];

const PHRASES = [
  "in today's digital age", "in today's fast-paced", 'it is worth noting',
  "it's worth noting", 'plays a crucial role', 'plays a vital role',
  'serves as a testament', 'in the realm of', 'delve into', 'deep dive',
  'harness the power of', 'embark on a journey', 'without further ado',
  "let's dive in", 'circle back', 'key takeaways', 'paradigm shift',
  'move the needle', 'low-hanging fruit', 'pain points', 'double-click on',
  'thought leader', 'best practices', 'the future looks bright',
  'exciting times lie ahead', 'marking a pivotal moment', 'a pivotal moment',
  'turning point', 'rapidly evolving', 'ever-evolving', 'game-changer',
  'game changer', 'at the end of the day', 'when it comes to',
];

const FILLER = [
  ['in order to', 'to'],
  ['due to the fact that', 'because'],
  ['at this point in time', 'now'],
  ['it is important to note that', ''],
  ['it should be noted that', ''],
  ['needless to say', ''],
  ['first and foremost', 'first'],
  ['in the event that', 'if'],
  ['for the purpose of', 'for'],
  ['a large number of', 'many'],
  ['the vast majority of', 'most'],
];

const CHATBOT = [
  'i hope this helps', 'let me know if', 'feel free to', 'great question',
  "you're absolutely right", 'happy to help', 'as an ai', 'as a language model',
  'as of my last training', 'while details are limited', "i'm confident that",
  'let me think', 'breaking this down', "you're asking about",
];

const VAGUE_ATTRIB = [
  'experts believe', 'experts say', 'experts agree', 'studies show',
  'research shows', 'research suggests', 'industry reports', 'many believe',
  'some argue', 'it is widely believed',
];

const HEDGES = [
  'could potentially', 'might possibly', 'may perhaps', 'might arguably',
  'could arguably', 'potentially possibly', 'somewhat relatively',
];

const COPULA_AVOID = /\b(serves? as|stands? as|functions? as|acts? as|boasts?|features)\b/gi;
const NEG_PARALLEL = /\b(?:it|this|that)(?:'s| is)? not (?:just|only|merely|simply)\b[^.!?\n]{0,80}?(?:\b(?:it(?:'s| is)?|but)\b|—|--|;)/gi;
const RULE_OF_THREE = /\b\w+(?:ing|ion|ity|ce|ss|ncy)?, \w+(?:ing|ion|ity|ce|ss|ncy)?,? and \w+/gi;
const EM_DASH = /—|--/g;
const CURLY = /[‘’“”]/g;

/* --------------------------------- helpers -------------------------------- */

function sentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || []);
}

function countHits(text, list) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const term of list) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const m = lower.match(re);
    if (m) hits.push({ term, count: m.length });
  }
  return hits;
}

function regexHits(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/* ---------------------------------- stats ---------------------------------- */

function stats(text) {
  const sents = sentences(text);
  const w = words(text);
  const lens = sents.map((s) => words(s).length).filter((n) => n > 0);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance = lens.length
    ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
    : 0;
  const sd = Math.sqrt(variance);
  const cov = mean > 0 ? sd / mean : 0; // burstiness proxy

  const uniq = new Set(w);
  const ttr = w.length ? uniq.size / w.length : 0;

  const tris = {};
  let triTotal = 0;
  let triRepeat = 0;
  for (let i = 0; i + 2 < w.length; i++) {
    const t = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
    tris[t] = (tris[t] || 0) + 1;
    triTotal++;
  }
  for (const t in tris) if (tris[t] > 1) triRepeat += tris[t] - 1;
  const triRate = triTotal ? triRepeat / triTotal : 0;

  return {
    sentences: sents.length,
    words: w.length,
    mean_sentence_length: +mean.toFixed(1),
    sentence_length_cov: +cov.toFixed(3), // human: high, AI: low
    type_token_ratio: +ttr.toFixed(3),
    trigram_repetition: +triRate.toFixed(3),
  };
}

/* --------------------------------- analyze --------------------------------- */

function analyze(text) {
  const findings = [];
  const add = (pattern, severity, detail, fix) =>
    findings.push({ pattern, severity, detail, fix });

  const t1 = countHits(text, TIER1);
  for (const h of t1)
    add('tier1_vocabulary', 'high', `"${h.term}" ×${h.count}`, 'Rewrite the sentence; do not synonym-swap.');

  const t2 = countHits(text, TIER2);
  const t2Total = t2.reduce((a, b) => a + b.count, 0);
  if (t2Total >= 2)
    add('tier2_density', 'medium', t2.map((h) => `"${h.term}" ×${h.count}`).join(', '), 'At most one per post.');

  for (const h of countHits(text, PHRASES))
    add('ai_phrase', 'high', `"${h.term}" ×${h.count}`, 'Delete or replace with a concrete claim.');

  for (const [bad] of FILLER) {
    const h = countHits(text, [bad]);
    if (h.length) add('filler', 'medium', `"${bad}"`, `Use the short form.`);
  }

  for (const h of countHits(text, CHATBOT))
    add('chatbot_artifact', 'high', `"${h.term}"`, 'Delete.');

  for (const h of countHits(text, VAGUE_ATTRIB))
    add('vague_attribution', 'high', `"${h.term}"`, 'Name the source or drop the claim.');

  for (const h of countHits(text, HEDGES))
    add('stacked_hedging', 'medium', `"${h.term}"`, 'One qualifier per claim.');

  const cop = text.match(COPULA_AVOID);
  if (cop) add('copula_avoidance', 'medium', cop.slice(0, 5).join(', '), 'Use "is" / "has".');

  const np = regexHits(text, NEG_PARALLEL);
  if (np) add('negative_parallelism', 'medium', `${np} instance(s) of "not just X, it's Y"`, 'State the claim directly.');

  const r3 = regexHits(text, RULE_OF_THREE);
  if (r3 >= 2) add('rule_of_three', 'low', `${r3} triadic lists`, 'Break the cadence; two items or four.');

  const sents = sentences(text);
  const emPerSent = sents.length ? regexHits(text, EM_DASH) / sents.length : 0;
  if (regexHits(text, EM_DASH) > 1 && emPerSent > 0.5)
    add('em_dash_overuse', 'medium', `${regexHits(text, EM_DASH)} em dashes in ${sents.length} sentences`, 'Max one per post.');

  if (regexHits(text, CURLY))
    add('curly_quotes', 'low', `${regexHits(text, CURLY)} curly quote characters`, 'Use straight quotes.');

  const st = stats(text);
  // Statistical tells only meaningful on longer prose.
  const longEnough = st.sentences >= 4 && st.words >= 60;
  if (longEnough) {
    if (st.sentence_length_cov < 0.3)
      add('low_burstiness', 'medium', `sentence-length CoV ${st.sentence_length_cov}`, 'Vary sentence length: short next to long.');
    if (st.type_token_ratio < 0.45)
      add('low_vocab_diversity', 'low', `TTR ${st.type_token_ratio}`, 'Cut repeated words.');
    if (st.trigram_repetition > 0.1)
      add('trigram_repetition', 'medium', `rate ${st.trigram_repetition}`, 'Rephrase repeated 3-word runs.');
  }

  /* ---- score ---- */
  const weights = {
    tier1_vocabulary: 12,
    ai_phrase: 10,
    chatbot_artifact: 15,
    vague_attribution: 10,
    tier2_density: 6,
    filler: 5,
    stacked_hedging: 5,
    copula_avoidance: 6,
    negative_parallelism: 6,
    rule_of_three: 3,
    em_dash_overuse: 4,
    curly_quotes: 2,
    low_burstiness: 8,
    low_vocab_diversity: 4,
    trigram_repetition: 6,
  };
  let raw = 0;
  for (const f of findings) raw += weights[f.pattern] || 3;
  const score = Math.min(100, raw);

  return { score, findings, stats: st };
}

/* --------------------------------- autofix --------------------------------- */

function autofix(text) {
  let out = text;
  for (const [bad, good] of FILLER) {
    const re = new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, good);
  }
  out = out
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return out;
}

/* ----------------------------------- io ------------------------------------ */

function readInput(args) {
  const fIdx = args.indexOf('-f');
  if (fIdx !== -1 && args[fIdx + 1]) return fs.readFileSync(args[fIdx + 1], 'utf8');
  const positional = args.filter((a) => !a.startsWith('-') && a !== args[0]);
  // last positional that is an existing file
  for (const p of positional.slice().reverse()) {
    try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8'); } catch (_) {}
  }
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'score';
  const json = args.includes('--json');
  const text = readInput(args).trim();
  if (!text) { console.error('No input text.'); process.exit(2); }
  const result = analyze(text);

  switch (cmd) {
    case 'score':
      console.log(result.score);
      break;
    case 'stats':
      console.log(JSON.stringify(result.stats, null, 2));
      break;
    case 'analyze':
    case 'report': {
      if (json) { console.log(JSON.stringify(result, null, 2)); break; }
      const lines = [];
      lines.push(`# Humanizer report`);
      lines.push(`Score: ${result.score}/100 (higher = more AI-like)`);
      lines.push('');
      lines.push(`## Findings (${result.findings.length})`);
      for (const f of result.findings)
        lines.push(`- [${f.severity}] ${f.pattern}: ${f.detail} → ${f.fix}`);
      lines.push('');
      lines.push('## Stats');
      for (const [k, v] of Object.entries(result.stats)) lines.push(`- ${k}: ${v}`);
      console.log(lines.join('\n'));
      break;
    }
    case 'suggest': {
      const bySev = { high: [], medium: [], low: [] };
      for (const f of result.findings) bySev[f.severity].push(f);
      for (const sev of ['high', 'medium', 'low']) {
        if (!bySev[sev].length) continue;
        console.log(`\n== ${sev.toUpperCase()} ==`);
        for (const f of bySev[sev]) console.log(`- ${f.pattern}: ${f.detail}\n  fix: ${f.fix}`);
      }
      break;
    }
    case 'humanize': {
      if (args.includes('--autofix')) {
        const fixed = autofix(text);
        const rescore = analyze(fixed).score;
        console.log(fixed);
        console.error(`\n[score ${result.score} → ${rescore} after autofix; remaining findings need manual rewrite]`);
      } else {
        console.log('Run with --autofix to apply safe replacements; see `suggest` for the rest.');
      }
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Use: score | analyze | stats | suggest | report | humanize`);
      process.exit(2);
  }
  if (cmd === 'score' && result.score >= 30) process.exitCode = 1; // CI-friendly
}

main();
