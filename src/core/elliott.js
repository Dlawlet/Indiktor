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

// T5: last two legs = A-B of a flat -> classify regular / expanded / running.
function tFlat(c) {
  if (c.length < 3) return null;
  const p = c.slice(-3);
  const dirA = sign(p[1].price - p[0].price);
  if (dirA === 0) return null;
  const bRet = len(p[1], p[2]) / len(p[0], p[1]);
  if (bRet < 0.9 || bRet > 1.5) return null; // outside the flat B-wave range
  const exceedsStart = dirA > 0 ? p[2].price > p[0].price : p[2].price < p[0].price;
  const kind = bRet >= 1.05 || exceedsStart ? 'expanded' : 'regular';
  const tgt = targets(kind === 'expanded' ? [1.272, 1.618] : IDEAL.flatC,
    p[0].price, p[1].price, p[2].price);
  return scenario({
    id: `flat-${kind}`,
    name: `${kind[0].toUpperCase()}${kind.slice(1)} flat wave C`,
    pattern: 'correction',
    bias: biasOf(dirA),
    targets: tgt,
    invalidation: p[1].price,
    guideline: fibCleanliness(bRet, kind === 'expanded' ? [1.236, 1.382] : [0.9, 1.0]),
    prior: kind === 'expanded' ? 0.4 : 0.35,
    anchorPivots: p,
    waveLabels: ['A', 'B', '→C'],
    currentWave: `${kind[0].toUpperCase()}${kind.slice(1)} flat C`,
    rationale:
      `B retraced ${(bRet * 100).toFixed(0)}% of A → ${kind} flat (3-3-5). ` +
      `Wave C ${kind === 'expanded' ? 'overshoots A' : 'roughly equals A'}.`,
  });
}

// T6: low-confidence baseline — trend simply continues the last leg.
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

const TEMPLATES = [tImpulseComplete, tWave3, tWave5, tZigzagC, tFlat, tContinuation];

/**
 * Run every template against the pivot sequence and return raw scenarios.
 * scoring.js converts these into ranked probabilities.
 */
export function analyze(pivots) {
  const confirmed = pivots.filter((p) => !p.tentative);
  const live = pivots[pivots.length - 1] ?? null;
  const scenarios = [];
  for (const t of TEMPLATES) {
    const s = t(confirmed, live);
    if (s) scenarios.push(s);
  }
  return { pivots, confirmed, live, scenarios };
}
