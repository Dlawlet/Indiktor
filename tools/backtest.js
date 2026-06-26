#!/usr/bin/env node
// Flat-pattern backtester: scans historical data for every regular-flat and
// running-flat occurrence, evaluates outcomes, and sweeps bRet thresholds to
// calibrate detection parameters.
//
// Usage:
//   node tools/backtest.js
//   node tools/backtest.js --symbol ETHUSDT --tf 1h
//   node tools/backtest.js --atr-mult 3 --bret-min 0.40
//   node tools/backtest.js --sweep           (bRet threshold sweep table)
//   node tools/backtest.js --candles 3000    (fetch more history)

import { zigzag } from '../src/core/zigzag.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const arg  = (flag, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${flag}=`));
  return hit ? hit.split('=')[1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SYMBOL      = arg('symbol',     'BTCUSDT');
const TF          = arg('tf',         '4h');
const ATR_MULT    = parseFloat(arg('atr-mult',    '3'));
const ATR_MACRO   = parseFloat(arg('atr-macro',   '2.5'));
const BRET_MIN    = parseFloat(arg('bret-min',    '0.40'));
const MIN_A_ATR   = parseFloat(arg('min-a-atr',   '1.0')); // min A size in ATR multiples
const N_CANDLES   = parseInt(arg('candles',       '1000'));
const SWEEP       = flag('sweep');
const ATR_SWEEP   = flag('atr-sweep');
const VERBOSE     = flag('verbose');

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------
async function fetchCandles(symbol, interval, limit) {
  const MAX = 1000;
  const collected = [];
  let endTime;
  const base = 'https://api.binance.com/api/v3/klines';
  while (collected.length < limit) {
    const need = Math.min(MAX, limit - collected.length);
    const url  = new URL(base);
    url.searchParams.set('symbol',   symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit',    String(need));
    if (endTime != null) url.searchParams.set('endTime', String(endTime));
    const res   = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol} ${interval}`);
    const batch = await res.json();
    if (!batch.length) break;
    collected.unshift(...batch.map(([t,o,h,l,c]) => ({
      time: Math.floor(t / 1000),
      open: +o, high: +h, low: +l, close: +c,
    })));
    endTime = batch[0][0] - 1;
    if (batch.length < need) break;
  }
  const seen = new Set();
  return collected
    .filter(c => seen.has(c.time) ? false : seen.add(c.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

// ---------------------------------------------------------------------------
// Flat scanner — ALL triplets in the pivot sequence
// Unlike analyze() which only checks the last N pivots, here we slide across
// the full confirmed pivot array to find every historical pattern instance.
// ---------------------------------------------------------------------------
// Rolling ATR for minimum-A-size filtering
function rollingAtr(candles, period = 14) {
  const map = new Map();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr   = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    if (i < period) { map.set(curr.time, tr); continue; }
    const prevAtr = map.get(candles[i - 1].time) ?? tr;
    map.set(curr.time, (prevAtr * (period - 1) + tr) / period);
  }
  return map;
}

function scanFlats(candles, opts = {}) {
  const {
    atrMult   = ATR_MULT,
    atrPeriod = 14,
    macroMult = ATR_MACRO,
    bRetMin   = BRET_MIN,
    minAAtr   = MIN_A_ATR,
  } = opts;
  const atrMap = minAAtr > 0 ? rollingAtr(candles, atrPeriod) : null;

  const results = [];
  const seen    = new Set();     // dedup by anchor-pivot time triplet

  function scanPivots(pivots, degree) {
    const conf = pivots.filter(p => !p.tentative);
    for (let i = 2; i < conf.length; i++) {
      const [a, b, c] = [conf[i - 2], conf[i - 1], conf[i]];
      const key = `${a.time}:${b.time}:${c.time}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const dirA = Math.sign(b.price - a.price);
      if (dirA === 0) continue;
      const aLen = Math.abs(b.price - a.price);
      const bLen = Math.abs(c.price - b.price);
      if (aLen < 1e-8) continue;
      // Skip micro-noise: require A ≥ minAAtr × ATR at A-start
      if (atrMap && minAAtr > 0) {
        const atr = atrMap.get(a.time);
        if (atr && aLen < atr * minAAtr) continue;
      }
      const bRet = bLen / aLen;

      // Classify: does B exceed A's starting price?
      const bExceedsAStart = dirA > 0 ? c.price < a.price : c.price > a.price;

      let type = null;
      if (!bExceedsAStart && bRet >= bRetMin && bRet < 1.0) type = 'regular';
      else if (bExceedsAStart && bRet >= 1.0 && bRet <= 3.0) type = 'running';
      if (!type) continue;

      // ---------------------------------------------------------------
      // Evaluate outcome: look forward in candle data from B-end.
      // Success  = C reached the primary target before invalidation.
      // Invalid  = price broke back through B-extreme before C completed.
      // Pending  = neither happened within the look-ahead window.
      // ---------------------------------------------------------------
      const bIdx   = candles.findIndex(cd => cd.time >= c.time);
      const ahead  = candles.slice(bIdx + 1, bIdx + 101);  // 100 candles forward

      const invalidationPrice = c.price; // B-extreme
      // Primary C target:
      //   regular: A's endpoint (C must break b.price to confirm the flat)
      //   running: 38.2% of B from B-end (C expected to be short)
      const target = type === 'regular'
        ? b.price
        : c.price + dirA * bLen * 0.382;

      let outcome = 'pending';
      let cLen    = 0;

      // C moves in the SAME direction as A (dirA).
      // dirA = +1 → A went UP → C goes UP → success when price HIGH reaches target.
      // dirA = -1 → A went DOWN → C goes DOWN → success when price LOW reaches target.
      // Invalidation: price goes back BEYOND B's extreme (B's endpoint = c.price),
      // meaning C never really started.
      for (const cd of ahead) {
        const hitTarget = dirA > 0
          ? cd.high >= target           // A went UP → C goes UP → high must reach target
          : cd.low  <= target;          // A went DOWN → C goes DOWN → low must reach target
        const invalid = dirA > 0
          ? cd.low  <= invalidationPrice // A went UP → invalidated if low drops below B-low
          : cd.high >= invalidationPrice; // A went DOWN → invalidated if high rises above B-high

        cLen = Math.abs(cd.close - c.price);

        if (hitTarget) { outcome = 'success';     break; }
        if (invalid)   { outcome = 'invalidated'; break; }
      }

      results.push({
        type, degree, dirA, bRet: +bRet.toFixed(3),
        aLen: +aLen.toFixed(2), bLen: +bLen.toFixed(2),
        aStart: a, aEnd: b, bEnd: c,
        outcome, cLen: +cLen.toFixed(2),
        ts: new Date(a.time * 1000).toISOString().slice(0, 16),
      });
    }
  }

  const fine  = zigzag(candles, { atrMult, atrPeriod });
  const macro = zigzag(candles, { atrMult: atrMult * macroMult, atrPeriod });
  scanPivots(fine,  'fine');
  scanPivots(macro, 'macro');

  // Sort by A-start time
  return results.sort((x, y) => x.aStart.time - y.aStart.time);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
function stats(patterns, type) {
  const g = patterns.filter(p => p.type === type);
  if (!g.length) return { n: 0 };
  const success     = g.filter(p => p.outcome === 'success').length;
  const invalidated = g.filter(p => p.outcome === 'invalidated').length;
  const pending     = g.filter(p => p.outcome === 'pending').length;
  const hitRate     = g.length ? (success / (success + invalidated) * 100) : 0;
  const bRets       = g.map(p => p.bRet).sort((a, b) => a - b);
  const p25         = bRets[Math.floor(bRets.length * 0.25)];
  const p50         = bRets[Math.floor(bRets.length * 0.50)];
  const p75         = bRets[Math.floor(bRets.length * 0.75)];
  return { n: g.length, success, invalidated, pending, hitRate: hitRate.toFixed(1), bRet: { p25, p50, p75 } };
}

// ---------------------------------------------------------------------------
// bRet threshold sweep — shows how detection count + hit-rate varies
// ---------------------------------------------------------------------------
function sweepBRet(candles, steps = 12) {
  const thresholds = Array.from({ length: steps }, (_, i) => +(0.25 + i * 0.05).toFixed(2));
  console.log(`\n── bRet threshold sweep (${SYMBOL} ${TF}) ──`);
  console.log(` bRet-min │ regular │ hit% │ running │ hit%`);
  console.log(` ─────────┼─────────┼──────┼─────────┼──────`);
  for (const t of thresholds) {
    const p = scanFlats(candles, { bRetMin: t });
    const r = stats(p, 'regular');
    const u = stats(p, 'running');
    const rHit = r.n ? `${r.hitRate}%` : '  —  ';
    const uHit = u.n ? `${u.hitRate}%` : '  —  ';
    console.log(
      `   ${t.toFixed(2)}   │  ${String(r.n).padStart(5)}  │ ${rHit.padStart(5)} │  ${String(u.n).padStart(5)}  │ ${uHit.padStart(5)}`
    );
  }
}

// ---------------------------------------------------------------------------
// ATR multiplier sweep — shows how zigzag sensitivity affects detection count
// ---------------------------------------------------------------------------
function sweepAtr(candles) {
  const mults = [1.5, 2, 2.5, 3, 3.5, 4, 5, 6];
  console.log(`\n── ATR multiplier sweep (${SYMBOL} ${TF}, bRet-min=${BRET_MIN}) ──`);
  console.log(` atr-mult │ fine piv │ reg │ hit% │ run │ hit%`);
  console.log(` ─────────┼──────────┼─────┼──────┼─────┼──────`);
  for (const m of mults) {
    const p  = scanFlats(candles, { atrMult: m, bRetMin: BRET_MIN });
    const pv = zigzag(candles, { atrMult: m, atrPeriod: 14 });
    const conf = pv.filter(x => !x.tentative).length;
    const r  = stats(p, 'regular');
    const u  = stats(p, 'running');
    const rH = r.n ? `${r.hitRate}%` : ' — ';
    const uH = u.n ? `${u.hitRate}%` : ' — ';
    console.log(
      `   ${String(m).padStart(4)}   │  ${String(conf).padStart(6)}  │ ${String(r.n).padStart(3)} │ ${rH.padStart(5)} │ ${String(u.n).padStart(3)} │ ${uH.padStart(5)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Verbose pattern list
// ---------------------------------------------------------------------------
function printPatterns(patterns, type) {
  const g = patterns.filter(p => p.type === type);
  if (!g.length) { console.log('  (none detected)'); return; }
  const dirLabel = d => d > 0 ? '↑bull' : '↓bear';
  const outLabel = o => ({ success: '✓', invalidated: '✗', pending: '?' })[o] ?? '?';
  g.forEach(p => {
    console.log(
      `  ${outLabel(p.outcome)} ${p.ts}  ${dirLabel(p.dirA)}  bRet=${p.bRet.toFixed(2)}` +
      `  A=${p.aLen.toFixed(0)}pts  B=${p.bLen.toFixed(0)}pts  [${p.degree}]`
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`Fetching ${N_CANDLES} ${SYMBOL} ${TF} candles…`);
const candles = await fetchCandles(SYMBOL, TF, N_CANDLES);
console.log(`Loaded ${candles.length} candles  (${
  new Date(candles[0].time * 1000).toISOString().slice(0,10)
} → ${
  new Date(candles[candles.length-1].time * 1000).toISOString().slice(0,10)
})`);

if (SWEEP) {
  sweepBRet(candles);
  process.exit(0);
}
if (ATR_SWEEP) {
  sweepAtr(candles);
  process.exit(0);
}

const patterns = scanFlats(candles);

// ── Summary ──
const r = stats(patterns, 'regular');
const u = stats(patterns, 'running');
const allN = patterns.length;

console.log(`\n══════════════════════════════════════════════`);
console.log(` Flat pattern scan  (bRet-min=${BRET_MIN}, atrMult=${ATR_MULT})`);
console.log(`══════════════════════════════════════════════`);
console.log(` Total detected : ${allN}`);
console.log(``);
console.log(` Regular flat   : ${r.n} patterns`);
if (r.n) {
  console.log(`   ✓ success     : ${r.success}  (${r.hitRate}% hit rate, excl. pending)`);
  console.log(`   ✗ invalidated : ${r.invalidated}`);
  console.log(`   ? pending     : ${r.pending}`);
  console.log(`   bRet p25/p50/p75 : ${r.bRet.p25} / ${r.bRet.p50} / ${r.bRet.p75}`);
}
console.log(``);
console.log(` Running flat   : ${u.n} patterns`);
if (u.n) {
  console.log(`   ✓ success     : ${u.success}  (${u.hitRate}% hit rate, excl. pending)`);
  console.log(`   ✗ invalidated : ${u.invalidated}`);
  console.log(`   ? pending     : ${u.pending}`);
  console.log(`   bRet p25/p50/p75 : ${u.bRet.p25} / ${u.bRet.p50} / ${u.bRet.p75}`);
}

if (VERBOSE) {
  console.log(`\n── Regular flats ──`);
  printPatterns(patterns, 'regular');
  console.log(`\n── Running flats ──`);
  printPatterns(patterns, 'running');
}

console.log(`\n── Tip ──`);
console.log(` --sweep            bRet threshold sweep table`);
console.log(` --atr-sweep        ATR multiplier sweep table`);
console.log(` --verbose          list every detected pattern`);
console.log(` --min-a-atr=2      skip patterns where A < 2× ATR (filter micro-noise)`);
console.log(` --tf=1h --candles=3000   longer history`);
