// The wave engine. Reads the zigzag pivot sequence and emits competing forward
// scenarios, each with target zones, an invalidation level, and raw quality
// metrics. scoring.js turns those metrics into probabilities.
//
// Design notes:
// - We reason on CONFIRMED pivots for structure and treat the trailing tentative
//   pivot (the live swing extreme) as "where price is now".
// - Elliott counts are inherently ambiguous, so several templates may fire on the
//   same pivots on purpose — that ambiguity IS the multi-scenario output.

import { projectFrom, ratioOf, fibCleanliness } from './fib.js';

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const len = (a, b) => Math.abs(b.price - a.price);
const biasOf = (dir) => (dir > 0 ? 'up' : 'down');

// Ideal Fibonacci targets per relationship, used both to project and to score.
const IDEAL = {
  wave2: [0.5, 0.618],
  wave4: [0.236, 0.382],
  wave3ext: [1.618, 2.0, 2.618],
  wave5: [0.618, 1.0, 1.618],
  zigzagC: [1.0, 1.618],
  flatC: [1.0, 1.272, 1.618],
};

/**
 * Hard-rule check for a 6-pivot (5-wave) impulse. Direction is inferred from the
 * net move. Returns validity, per-rule booleans, leg lengths and guideline ratios.
 */
export function checkImpulse(p) {
  if (p.length < 6) return { valid: false, reason: 'need 6 pivots' };
  const dir = sign(p[5].price - p[0].price);
  if (dir === 0) return { valid: false, reason: 'flat net move' };

  const w1 = len(p[0], p[1]), w2 = len(p[1], p[2]), w3 = len(p[2], p[3]),
        w4 = len(p[3], p[4]), w5 = len(p[4], p[5]);

  // R1: wave 2 never retraces more than 100% of wave 1.
  const r1 = dir > 0 ? p[2].price > p[0].price : p[2].price < p[0].price;
  // R2: wave 3 is never the shortest of waves 1/3/5.
  const r2 = !(w3 < w1 && w3 < w5);
  // R3: wave 4 never enters wave 1 price territory.
  const r3 = dir > 0 ? p[4].price > p[1].price : p[4].price < p[1].price;

  return {
    valid: r1 && r2 && r3,
    dir,
    rules: { r1, r2, r3 },
    lengths: { w1, w2, w3, w4, w5 },
    metrics: { w2ret: w2 / w1, w4ret: w4 / w3, w3ext: w3 / w1 },
  };
}

/** Partial-impulse check for waves 1-2-3-4 (5 pivots), wave 5 not yet formed. */
export function checkPartialImpulse(p) {
  if (p.length < 5) return { valid: false, reason: 'need 5 pivots' };
  const dir = sign(p[3].price - p[0].price);
  if (dir === 0) return { valid: false, reason: 'flat net move' };
  const w1 = len(p[0], p[1]), w3 = len(p[2], p[3]);
  const r1 = dir > 0 ? p[2].price > p[0].price : p[2].price < p[0].price;
  const r3 = dir > 0 ? p[4].price > p[1].price : p[4].price < p[1].price;
  const r2partial = w3 >= w1 * 0.9; // wave 3 at least comparable to wave 1 so far
  return { valid: r1 && r3 && r2partial, dir, rules: { r1, r3, r2partial }, lengths: { w1, w3 } };
}

// --- scenario templates ----------------------------------------------------
// Each returns a scenario object or null. `c` = confirmed pivots, `live` = the
// current (possibly tentative) extreme.

function scenario(o) {
  return {
    rules: { failed: [] },
    guideline: 0.5,
    prior: 0.5,
    targets: [],
    ...o,
  };
}

function targets(ratios, baseA, baseB, origin, idealKey) {
  const projected = projectFrom(baseA, baseB, origin, ratios);
  return projected.map((t) => ({ label: `${t.ratio}x`, ratio: t.ratio, price: t.price }));
}

// T1: a complete 5-wave impulse -> expect a corrective move against it.
function tImpulseComplete(c) {
  if (c.length < 6) return null;
  const p = c.slice(-6);
  const imp = checkImpulse(p);
  if (!imp.valid) return null;
  const dir = imp.dir;
  const whole = { a: p[0].price, b: p[5].price };
  // correction retraces the whole impulse
  const tgt = [0.382, 0.5, 0.618].map((r) => ({
    label: `${r} retr`, ratio: r, price: whole.b - (whole.b - whole.a) * r,
  }));
  // guideline quality from how Fib-clean the impulse was
  const g =
    (fibCleanliness(imp.metrics.w2ret, IDEAL.wave2) +
      fibCleanliness(imp.metrics.w4ret, IDEAL.wave4) +
      fibCleanliness(imp.metrics.w3ext, IDEAL.wave3ext)) / 3;
  return scenario({
    id: 'impulse-complete',
    name: 'Impulse complete → correction',
    pattern: 'correction',
    bias: biasOf(-dir),
    targets: tgt,
    invalidation: p[5].price,
    guideline: g,
    prior: 0.6,
    anchorPivots: p,
    waveLabels: ['0', '1', '2', '3', '4', '5'],
    currentWave: 'A-B-C correction',
    rationale:
      `5-wave ${dir > 0 ? 'up' : 'down'} impulse looks complete (rules 1–3 pass). ` +
      `Expect an A-B-C correction retracing 38–62% of the move.`,
  });
}

// T2: last two legs = waves 1-2 -> expect wave 3 (the powerful one).
function tWave3(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dir = sign(p[1].price - p[0].price);
  if (dir === 0) return null;
  // wave 2 must not retrace > 100% of wave 1
  const r1 = dir > 0 ? p[2].price > p[0].price : p[2].price < p[0].price;
  if (!r1) return null;
  const w2ret = len(p[1], p[2]) / len(p[0], p[1]);
  const tgt = targets(IDEAL.wave3ext, p[0].price, p[1].price, p[2].price);
  return scenario({
    id: 'wave-3',
    name: 'Wave 3 underway',
    pattern: 'impulse',
    bias: biasOf(dir),
    targets: tgt,
    invalidation: p[0].price,
    guideline: fibCleanliness(w2ret, IDEAL.wave2),
    prior: 0.65,
    anchorPivots: p,
    waveLabels: ['0', '1', '2'],
    currentWave: 'Wave 3 target',
    rationale:
      `Reading the last two legs as waves 1–2 (wave 2 retraced ${(w2ret * 100).toFixed(0)}%). ` +
      `Wave 3 typically extends 1.618–2.618× wave 1.`,
  });
}

// T3: last four legs = waves 1-2-3-4 -> expect wave 5.
function tWave5(c) {
  if (c.length < 5) return null;
  const p = c.slice(-5);
  const imp = checkPartialImpulse(p);
  if (!imp.valid) return null;
  const dir = imp.dir;
  // wave 5 often equals wave 1 (1.0) projected from the end of wave 4
  const tgt = targets(IDEAL.wave5, p[0].price, p[1].price, p[4].price);
  return scenario({
    id: 'wave-5',
    name: 'Wave 5 expected',
    pattern: 'impulse',
    bias: biasOf(dir),
    targets: tgt,
    invalidation: p[4].price,
    guideline: 0.55,
    prior: 0.5,
    anchorPivots: p,
    waveLabels: ['0', '1', '2', '3', '4'],
    currentWave: 'Wave 5 target',
    rationale:
      `Waves 1–4 in place (no wave-1/4 overlap). Wave 5 commonly equals wave 1 ` +
      `(0.618–1.618×) measured from the wave-4 ${dir > 0 ? 'low' : 'high'}.`,
  });
}

// T4: last two legs = A-B of a zigzag -> expect wave C.
function tZigzagC(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const bRet = len(p[1], p[2]) / len(p[0], p[1]);
  if (bRet >= 1) return null; // B beyond A's start -> not a clean zigzag (see flat)
  const tgt = targets(IDEAL.zigzagC, p[0].price, p[1].price, p[2].price);
  return scenario({
    id: 'zigzag-c',
    name: 'Zigzag wave C',
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[0].price,
    guideline: fibCleanliness(bRet, [0.5, 0.618, 0.786]),
    prior: 0.45,
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: 'Zigzag wave C',
    rationale:
      `Last two legs read as A-B of a zigzag (B retraced ${(bRet * 100).toFixed(0)}% of A). ` +
      `Wave C usually travels 1.0–1.618× wave A.`,
  });
}

// T5: Regular flat — a CORRECTION flag.
// B retraces 65-99% of A, staying between A's two extremes (B does NOT break A's origin).
// C then breaks A's endpoint, completing the correction, after which the PRIOR TREND resumes.
// Distinguished from running flat: in a regular flat the correction is genuine (the trend paused).
// If B exceeds A's origin that is a running flat — handled exclusively by tRunningFlat.
function tFlat(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const bRet = len(p[1], p[2]) / len(p[0], p[1]);
  // Backtester calibration: bRet ≥ 0.70 gives ~10% better hit rate than 0.65 on 1h/4h/1d
  // (76-81% vs 67-75% depending on timeframe). Worth losing a few extra detections.
  if (bRet < 0.70 || bRet >= 1.0) return null;
  // Explicit guard: B must stay below A's starting price.
  const exceedsStart = dirA > 0 ? p[2].price < p[0].price : p[2].price > p[0].price;
  if (exceedsStart) return null; // running flat territory — tRunningFlat handles it
  const tgt = targets(IDEAL.flatC, p[0].price, p[1].price, p[2].price);
  return scenario({
    id: 'flat-regular',
    name: 'Regular flat — correction flag',
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[2].price,
    guideline: fibCleanliness(bRet, [0.764, 0.854]),
    prior: 0.38,
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: 'Regular flat C',
    rationale:
      `B retraced ${(bRet * 100).toFixed(0)}% of A → regular flat (3-3-5 correction flag). ` +
      `C expected to break A's extreme; prior trend resumes once C completes.`,
  });
}

// T6: Running flat — a CONTINUITY flag of the current direction.
// B exceeds A's origin (runs to new territory in the trend direction) because the underlying
// trend is so strong the correction barely developed. C is only a minor pullback that falls
// SHORT of A's endpoint, then the trend RESUMES explosively.
// Mutually exclusive with tFlat: tFlat fires only when B stays within A's range.
function tRunningFlat(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const aLen = len(p[0], p[1]);
  const bLen = len(p[1], p[2]);
  const bRet = bLen / aLen;
  // B must exceed A's start (characteristic of running flat)
  const bExceedsAStart = dirA > 0 ? p[2].price < p[0].price : p[2].price > p[0].price;
  if (!bExceedsAStart) return null;
  if (bRet > 3.0) return null; // implausibly large B
  // C travels in the same direction as A but falls short — targets are fractions of B
  const tgt = [0.382, 0.618, 0.786].map((r) => ({
    label: `${r}× B`, ratio: r,
    price: p[2].price + dirA * bLen * r,
  }));
  return scenario({
    id: 'running-flat',
    name: 'Running flat wave C',
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[2].price, // new B extreme means C hasn't started
    guideline: fibCleanliness(bRet, [1.236, 1.382]),
    prior: 0.42, // Wave Theory: running flat is the strongest continuation signal — B breaking A's origin signals extreme underlying momentum
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: 'Running flat C',
    rationale:
      `B retraced ${(bRet * 100).toFixed(0)}% of A and broke A's origin → running flat (continuity flag). ` +
      `The trend never stopped — C is a minor pullback (38–79% of B) before explosive resumption.`,
  });
}

// T9: Expanding triangle — 5 alternating waves (A-B-C-D-E), each LARGER than the
// prior (opposite of contracting). Less common; breakout direction same as wave A.
// Requires 6 confirmed pivots.
function tExpandingTriangle(c) {
  if (c.length < 6) return null;
  const p = c.slice(-6);
  // Compute 5 legs
  const legs5 = [];
  for (let i = 1; i < 6; i++) legs5.push(p[i].price - p[i - 1].price);
  // Strict alternation: consecutive legs must have opposite sign
  for (let i = 1; i < legs5.length; i++) {
    if (Math.sign(legs5[i]) === Math.sign(legs5[i - 1]) || legs5[i] === 0) return null;
  }
  const sizes = legs5.map(Math.abs);
  // Each size must NOT be smaller than 90% of the previous (allow small noise buffer)
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] < sizes[i - 1] * 0.9) return null;
  }
  // Require at least 2 clearly expanding pairs (> 10% bigger than prior)
  const clearPairs = sizes.filter((s, i) => i > 0 && s > sizes[i - 1] * 1.1).length;
  if (clearPairs < 2) return null;
  // Breakout direction: same as wave A (first leg)
  const breakoutDir = Math.sign(legs5[0]);
  const eLen = sizes[4];
  const tgt = [0.618, 1.0, 1.618].map((r) => ({
    label: `${r}× E`, ratio: r,
    price: p[5].price + breakoutDir * eLen * r,
  }));
  return scenario({
    id: 'expanding-triangle',
    name: 'Expanding triangle → breakout',
    pattern: 'continuation',
    bias: biasOf(breakoutDir),
    targets: tgt,
    // E-end is the last pivot; re-entering through E means pattern failed
    invalidation: p[5].price,
    guideline: fibCleanliness(sizes[1] / sizes[0], [1.236, 1.382]) * 0.5 +
               fibCleanliness(sizes[2] / sizes[1], [1.236, 1.382]) * 0.5,
    prior: 0.25,
    anchorPivots: p,
    waveLabels: ['0', 'A', 'B', 'C', 'D', 'E→'],
    currentWave: 'Expanding triangle thrust',
    rationale:
      `5-wave expanding triangle (A<B<C<D<E, ${clearPairs} clear expansions). ` +
      `Breakout ${breakoutDir > 0 ? 'up' : 'down'} (same as A) targeting 0.618–1.618× E from E.`,
  });
}

// T7: Contracting triangle — 5 alternating waves (A-B-C-D-E), each shorter than the
// previous. Common in Wave 4 or Wave B. After E, price breaks out and resumes the
// prior trend. Requires 6 confirmed pivots.
function tContractingTriangle(c) {
  if (c.length < 6) return null;
  const p = c.slice(-6);
  // Verify strict alternation of direction across all 5 legs
  const legs5 = [];
  for (let i = 1; i < 6; i++) legs5.push(p[i].price - p[i - 1].price);
  for (let i = 1; i < legs5.length; i++) {
    if (Math.sign(legs5[i]) === Math.sign(legs5[i - 1]) || legs5[i] === 0) return null;
  }
  const sizes = legs5.map(Math.abs);
  // Each wave must not be longer than the previous (allow 10% buffer for noise)
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] > sizes[i - 1] * 1.1) return null;
  }
  // At least two consecutive pairs must show clear contraction (< 90%)
  const clearPairs = sizes.filter((s, i) => i > 0 && s < sizes[i - 1] * 0.9).length;
  if (clearPairs < 2) return null;
  // Breakout direction: opposite to the first wave (A), resuming the prior trend
  const breakoutDir = -Math.sign(legs5[0]);
  const aLen = sizes[0];
  const tgt = [0.618, 1.0, 1.618].map((r) => ({
    label: `${r}× A`, ratio: r,
    price: p[5].price + breakoutDir * aLen * r,
  }));
  return scenario({
    id: 'contracting-triangle',
    name: 'Contracting triangle → breakout',
    pattern: 'continuation',
    bias: biasOf(breakoutDir),
    targets: tgt,
    // E-end is the last pivot; breaking back through it means the triangle is extending or failed
    invalidation: p[5].price,
    guideline: fibCleanliness(sizes[1] / sizes[0], [0.618, 0.786]) * 0.5 +
               fibCleanliness(sizes[2] / sizes[1], [0.618, 0.786]) * 0.5,
    prior: 0.45,
    anchorPivots: p,
    waveLabels: ['0', 'A', 'B', 'C', 'D', 'E→'],
    currentWave: 'Triangle breakout',
    rationale:
      `5-wave contracting triangle (A>B>C>D>E, ${clearPairs} clear contractions). ` +
      `Breakout ${breakoutDir > 0 ? 'up' : 'down'} targeting 0.618–1.618× A from E.`,
  });
}

// T10: Double zigzag (W-X-Y) — two zigzag corrections linked by an X wave.
// Overall bias follows W direction. Minimum 5 confirmed pivots.
function tDoubleZigzag(c) {
  if (c.length < 5) return null;
  const p = c.slice(-5);
  // W direction
  const dirW = sign(p[1].price - p[0].price);
  if (dirW === 0) return null;
  const wLen = len(p[0], p[1]);
  // X wave: retraces some of W but must not exceed W's start
  const xLen = len(p[1], p[2]);
  const xRet = xLen / wLen;
  if (xRet >= 1.0) return null; // X exceeded W's start
  if (xRet < 0.1) return null;  // X too tiny
  // Y's first leg (Y-A) must go in same direction as W
  const dirY = sign(p[3].price - p[2].price);
  if (dirY !== dirW) return null;
  const yALen = len(p[2], p[3]);
  // Y's second leg (Y-B): partial retrace of Y-A
  const yBLen = len(p[3], p[4]);
  const yBRet = yBLen / yALen;
  if (yBRet >= 1.0) return null; // Y-B exceeded Y-A start
  if (yBRet < 0.1) return null;  // Y-B too tiny
  // Y-C targets: 1.0× and 1.618× of Y-A from Y-B end (p[4])
  const tgt = [1.0, 1.618].map((r) => ({
    label: `Y-C ${r}×`, ratio: r, price: p[4].price + dirW * yALen * r,
  }));
  return scenario({
    id: 'double-zigzag',
    name: 'Double zigzag W-X-Y',
    pattern: 'correction',
    bias: biasOf(dirW),
    targets: tgt,
    // If price breaks back through X's end, Y hasn't formed
    invalidation: p[2].price,
    guideline: fibCleanliness(xRet, [0.5, 0.618]) * 0.5 +
               fibCleanliness(yBRet, [0.5, 0.618]) * 0.5,
    prior: 0.3,
    anchorPivots: p,
    waveLabels: ['W₀', 'W', 'X', 'Y-A', 'Y-B'],
    currentWave: 'Y-C (double zigzag)',
    rationale:
      `W-X-Y double zigzag: W moved ${dirW > 0 ? 'up' : 'down'}, X retraced ${(xRet * 100).toFixed(0)}% of W, ` +
      `Y underway (Y-B: ${(yBRet * 100).toFixed(0)}% of Y-A). Y-C targets 1.0–1.618× Y-A.`,
  });
}

// T8: low-confidence baseline — trend simply continues the last leg.
function tContinuation(c, live) {
  if (c.length < 2) return null;
  const p = c.slice(-2);
  const dir = sign(p[1].price - p[0].price);
  if (dir === 0) return null;
  const swing = len(p[0], p[1]);
  const tgt = [0.618, 1.0].map((r) => ({
    label: `${r}x swing`, ratio: r, price: p[1].price + dir * swing * r,
  }));
  return scenario({
    id: 'continuation',
    name: 'Trend continuation (baseline)',
    pattern: 'continuation',
    bias: biasOf(dir),
    targets: tgt,
    invalidation: p[0].price,
    guideline: 0.3,
    prior: 0.3,
    anchorPivots: p,
    waveLabels: ['prev', '→'],
    currentWave: 'Trend continuation',
    rationale: 'Baseline: the most recent leg simply extends. Low-conviction fallback.',
  });
}

// T6b: Expanding flat — B runs past A's origin (same as running flat) BUT C also breaks
// A's endpoint, so the whole correction "expands" beyond A in both directions.
// This is what the analyst identifies when a running flat is "invalidated" by C going deeper:
// "il n'y a plus de running, je me retrouve avec un expanding."
// Prior is lower than running flat — it means the correction is stronger than expected.
// Both running-flat and flat-expanding fire when B exceeds A's origin; the difference is
// in the projected C target: running-flat C falls short, flat-expanding C breaks through.
function tExpandingFlat(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const aLen = len(p[0], p[1]);
  const bLen = len(p[1], p[2]);
  const bRet = bLen / aLen;
  const bExceedsAStart = dirA > 0 ? p[2].price < p[0].price : p[2].price > p[0].price;
  if (!bExceedsAStart || bRet > 3.0) return null;
  // C expected to BREAK A's endpoint (1.0–1.618× A from B's end in A's direction).
  // This puts C further than A's low/high, expanding the overall correction.
  const tgt = [1.0, 1.272, 1.618].map((r) => ({
    label: `${r}× A`, ratio: r,
    price: p[2].price + dirA * aLen * r,
  }));
  return scenario({
    id: 'flat-expanding',
    name: 'Expanding flat wave C',
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[2].price,
    guideline: fibCleanliness(bRet, [1.236, 1.382]) * 0.65,
    prior: 0.20,
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: 'Expanding flat C',
    rationale:
      `B ran ${(bRet * 100).toFixed(0)}% of A past A's origin → expanding flat. ` +
      `Unlike running flat, C is expected to ALSO break A's endpoint — deeper correction before resumption.`,
  });
}

// T6c: Contracting flat — B retraces only 25–64% of A (very small correction),
// C also expected to stay SHORT of A's endpoint (0.5–0.786× A from B's end).
// The structure "contracts" — each swing is smaller than the last.
// Signal: volatility compression, market coiling, breakout pending.
// Low prior; often appears just before impulsive moves.
function tContractingFlat(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const aLen = len(p[0], p[1]);
  const bRet = len(p[1], p[2]) / aLen;
  // B very small relative to A — contracting, not a full retrace
  if (bRet < 0.25 || bRet >= 0.65) return null;
  const exceedsStart = dirA > 0 ? p[2].price < p[0].price : p[2].price > p[0].price;
  if (exceedsStart) return null;
  // C falls short of A's endpoint (compression continues)
  const tgt = [0.5, 0.618, 0.786].map((r) => ({
    label: `${r}× A`, ratio: r,
    price: p[2].price + dirA * aLen * r,
  }));
  return scenario({
    id: 'flat-contracting',
    name: 'Contracting flat wave C',
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[2].price,
    guideline: fibCleanliness(bRet, [0.382, 0.5]) * 0.7,
    prior: 0.18,
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: 'Contracting flat C',
    rationale:
      `B retraced only ${(bRet * 100).toFixed(0)}% of A → contracting flat (volatility compression). ` +
      `C expected to stay short of A's endpoint (50–79% of A). Market coiling before breakout.`,
  });
}

// Flat-family templates are separated so they can be run with the structural
// multi-leg scanner (Pass 2 in analyze) in addition to the standard sliding window.
const FLAT_FAMILY = [tFlat, tRunningFlat, tExpandingFlat, tContractingFlat];
const TEMPLATES = [tImpulseComplete, tWave3, tWave5, tZigzagC, ...FLAT_FAMILY, tExpandingTriangle, tContractingTriangle, tDoubleZigzag, tContinuation];

/**
 * Run every template against the pivot sequence and return raw scenarios.
 * scoring.js converts these into ranked probabilities.
 *
 * Two-pass approach:
 *
 * Pass 1 — all templates, sliding offset window (existing):
 *   Each template tries the last N confirmed pivots at offsets 0-2 so micro
 *   sub-swings don't hide the true count.
 *
 * Pass 2 — flat family only, structural multi-leg scan (new):
 *   The "right origin" for a flat is the DOMINANT structural swing, not just
 *   the nearest adjacent pivot. We scan ALL valid (A-start, A-end, B-end)
 *   triplets where:
 *     - A-start and B-end share the same pivot TYPE (both H or both L)
 *     - A-end is the opposite type — enforces proper A/B direction
 *     - A spans 1–9 zigzag legs (covers fine through macro structures)
 *     - B spans 1–5 zigzag legs
 *   This mirrors how an analyst's eye finds a flat: identify the dominant
 *   structural origin, confirm B stays within / breaks A's bounds, project C.
 */
export function analyze(pivots, maxOffset = 2) {
  const confirmed = pivots.filter((p) => !p.tentative);
  const live = pivots[pivots.length - 1] ?? null;
  const seen = new Set();
  const scenarios = [];

  // ── Pass 1: all templates, sliding offset window ──────────────────────────
  for (let offset = 0; offset <= maxOffset; offset++) {
    const view = offset === 0 ? confirmed : confirmed.slice(0, -offset);
    for (const t of TEMPLATES) {
      const s = t(view, live);
      if (!s) continue;
      const key = `${s.id}:${s.bias}:${s.anchorPivots?.[0]?.time ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const disc = Math.pow(0.88, offset);
      scenarios.push(offset === 0 ? s : { ...s, guideline: Math.max(0, s.guideline * disc) });
    }
  }

  // ── Pass 2: flat family, structural multi-leg origin scan ─────────────────
  // For the current B-end pivot, find the SINGLE BEST (A-start, A-end, B-end)
  // triplet per flat type × direction, judged by guideline quality.
  // "Best" = highest guideline score — rewarded by the bRet being closest to
  // ideal values, which naturally selects the most structurally clean origin.
  const n = confirmed.length;
  if (n >= 3) {
    const bEnd = confirmed[n - 1];
    // best["id:bias"] → the highest-guideline scenario found so far
    const best = new Map();

    for (let bSpan = 1; bSpan <= 5; bSpan++) {
      const aEndIdx = n - 1 - bSpan;
      if (aEndIdx < 1) break;
      const aEnd = confirmed[aEndIdx];
      // A-end must be opposite type to B-end
      if (aEnd.type === bEnd.type) continue;

      for (let aSpan = 1; aSpan <= 9; aSpan++) {
        const aStartIdx = aEndIdx - aSpan;
        if (aStartIdx < 0) break;
        const aStart = confirmed[aStartIdx];
        // A-start must match B-end type (H-L-H or L-H-L triplet)
        if (aStart.type !== bEnd.type) continue;

        const view3 = [aStart, aEnd, bEnd];
        for (const t of FLAT_FAMILY) {
          const s = t(view3, live);
          if (!s) continue;
          const mapKey = `${s.id}:${s.bias}`;
          const prev = best.get(mapKey);
          if (!prev || s.guideline > prev.guideline) best.set(mapKey, s);
        }
      }
    }

    // Emit best multi-stride scenarios, skipping anything Pass 1 already found
    for (const s of best.values()) {
      const key = `${s.id}:${s.bias}:${s.anchorPivots?.[0]?.time ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scenarios.push(s);
    }
  }

  return { pivots, confirmed, live, scenarios };
}
