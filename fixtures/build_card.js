#!/usr/bin/env node
/* Fixture card builder — proves the card rules are satisfiable in practice.
 * Variant: "bracket-split" — the two deciding levels as paired columns with
 * the live print on the axis between them. */
'use strict';
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('fixtures/payload.json', 'utf8'));
const logo = fs.readFileSync('bearpaws_logo_white.svg').toString('base64');

const hi = p.market_state.levels[1].price.toFixed(1);
const lo = p.market_state.levels[0].price.toFixed(1);
const ah = p.market_state.asia_range.high.toFixed(1);
const al = p.market_state.asia_range.low.toFixed(1);
const t = p.calendar[0].time_utc.slice(11, 16);

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root {
  --bp-surface: #0B0F19;
  --bp-accent: #3B82F6;
  --bp-text: #E8EDF7;
  --bp-muted: #64748B;
}
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1600px; height:900px; }
body {
  background: var(--bp-surface); color: var(--bp-text);
  font-family: Inter, system-ui, sans-serif;
  display:grid; grid-template-rows:auto 1fr auto; padding:72px 88px;
}
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
header { display:flex; justify-content:space-between; align-items:baseline; }
h1 { font-size:34px; font-weight:600; letter-spacing:-0.01em; }
.slot { color: var(--bp-muted); font-size:22px; letter-spacing:0.08em; text-transform:uppercase; }
main { display:grid; grid-template-columns:1fr 2px 1fr; align-items:center; gap:0 64px; }
.side { display:flex; flex-direction:column; gap:14px; }
.side.low { text-align:right; }
.cap { color: var(--bp-muted); font-size:24px; letter-spacing:0.04em; }
.lvl { font-size:132px; line-height:1; font-weight:600; letter-spacing:-0.03em; }
.axis { background: var(--bp-accent); height:340px; width:2px; align-self:center; }
.range { color: var(--bp-muted); font-size:26px; }
.range b { color: var(--bp-text); font-weight:500; }
footer { display:flex; justify-content:space-between; align-items:flex-end; }
.evt { font-size:28px; }
.evt span { color: var(--bp-muted); }
img.logo { height:34px; opacity:0.9; }
</style></head><body>
<header>
  <h1>${p.instrument}</h1>
  <div class="slot">Session map</div>
</header>
<main>
  <div class="side">
    <div class="cap">Above &mdash; prior day high</div>
    <div class="lvl mono" data-value="${hi}">${hi}</div>
    <div class="range">Asia high <b class="mono" data-value="${ah}">${ah}</b></div>
  </div>
  <div class="axis"></div>
  <div class="side low">
    <div class="cap">Below &mdash; weekly open</div>
    <div class="lvl mono" data-value="${lo}">${lo}</div>
    <div class="range">Asia low <b class="mono" data-value="${al}">${al}</b></div>
  </div>
</main>
<footer>
  <div class="evt"><span>Core PCE</span> <b class="mono" data-value="${t}">${t}</b> <span>UTC</span></div>
  <img class="logo" src="data:image/svg+xml;base64,${logo}" alt="Bearpaws">
</footer>
</body></html>`;

fs.writeFileSync('out/2026-08-19_morning_map.html', html);
console.log('card html written');
