/**
 * Ghost-candle forecast for selected Elliott Wave scenarios.
 *
 * Returns { candles, projectedPivots } where:
 *   candles          – OHLC array to render as grey ghost bars
 *   projectedPivots  – key turning points { time, price, label, dir }
 *                      used for schematic markers + dashed polyline overlay
 *
 * CHANNEL-AWARE (wave-3/5, zigzag-C, flat-C, double-zigzag):
 *   Path oscillates WITHIN the channel defined by anchorPivots.
 *   wave-3 specifically shows the FULL REMAINING IMPULSE (W3 + W4 + W5)
 *   so the user sees what must happen to complete and validate the 5-wave.
 *
 * FREE-PATH (impulse-complete → A-B-C, triangle thrust, continuation):
 *   Pattern complete; next channel unknown. Uses A-B-C or thrust sub-structure.
 *
 * Duration: estimated from the TIME of prior wave swings via Elliott ratios.
 */

const CHANNEL_AWARE = new Set([
  'wave-3', 'wave-5',
  'zigzag-c', 'flat-regular', 'flat-expanded', 'running-flat',
  'double-zigzag',
]);

export function projectGhostCandles({ scenario, anchorPivots, currentPrice, atr, lastTime, intervalSec }) {
  const target = scenario.targets[0]?.price;
  if (!target || !Number.isFinite(target)) return { candles: [], projectedPivots: [] };

  const dir = target > currentPrice ? 1 : -1;
  const dist = Math.abs(target - currentPrice);
  if (dist < atr * 0.3) return { candles: [], projectedPivots: [] };

  const count = clamp(
    estimateCandleCount(scenario.id, anchorPivots, intervalSec, dist, atr),
    6, 50,
  );

  if (CHANNEL_AWARE.has(scenario.id) && anchorPivots?.length >= 3) {
    return buildChannelPath(anchorPivots, currentPrice, atr, lastTime, intervalSec, count, scenario.id);
  }

  return buildFreePath(currentPrice, target, dir, dist, atr, lastTime, intervalSec, count, scenario.id);
}

// ---------------------------------------------------------------------------
// Channel-aware path
// ---------------------------------------------------------------------------

function buildChannelPath(anchorPivots, currentPrice, atr, lastTime, intervalSec, count, scenarioId) {
  const p = anchorPivots.slice(-3);
  if (p[2].time <= p[0].time) return { candles: [], projectedPivots: [] };

  const slope  = (p[2].price - p[0].price) / (p[2].time - p[0].time);
  const lineAt = (t) => p[0].price + slope * (t - p[0].time);
  const offset = p[1].price - lineAt(p[1].time);
  if (offset === 0) return { candles: [], projectedPivots: [] };

  const dir = Math.sign(offset); // +1 UP channel, -1 DOWN channel
  const priceAt = (t, phase) => lineAt(t) + phase * offset;
  const startPhase = clamp01((currentPrice - lineAt(lastTime)) / offset);

  const PHASES = scenarioId === 'wave-3'
    ? fullImpulsePhases(startPhase)   // W3 + W4 + W5 remaining structure
    : defaultImpulsePhases(startPhase); // current wave to completion

  const candles = [];
  let prevClose = currentPrice;
  for (let i = 0; i < count; i++) {
    const t = lastTime + (i + 1) * intervalSec;
    const phase = phaseLerp(PHASES, (i + 1) / count);
    const osc   = Math.sin(i * 2.13 + phase) * atr * 0.04;
    const close = priceAt(t, phase) + osc;
    const open  = prevClose;
    const spread = atr * 0.055;
    candles.push({ time: t, open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close });
    prevClose = close;
  }

  const projectedPivots = extractChannelPivots(scenarioId, candles, dir);
  return { candles, projectedPivots };
}

/**
 * 8-knot phase pattern for wave-3 scenario: shows the FULL remaining impulse.
 *
 * Phase 0 = base-line (a/c side — the wave-2 low for UP).
 * Phase 1 = channel parallel (b side — where wave-1 peaked).
 * Phase > 1 = extends beyond the parallel (classic EW extension).
 *
 * Progress 0.00–0.62 = Wave 3 with its own 5 sub-waves.
 * Progress 0.62–0.76 = Wave 4 correction (stays ≥ phase 1.03, above W1 high).
 * Progress 0.76–1.00 = Wave 5 push to ultimate TP (beyond the parallel).
 */
function fullImpulsePhases(sp) {
  return [
    [0.00, sp  ],  // W2 end — at base line
    [0.13, 0.82],  // W3.w1 sub-peak — near parallel
    [0.21, 0.26],  // W3.w2 sub-retrace — above base
    [0.40, 1.22],  // W3.w3 sub-extension — breaks through parallel
    [0.51, 0.68],  // W3.w4 sub-retrace
    [0.62, 1.06],  // W3 complete (W3.w5) — just above parallel = W3 TP
    [0.76, 1.03],  // W4 low — just above parallel (EW: must be above W1 peak)
    [1.00, 1.15],  // W5 ultimate TP — beyond parallel
  ];
}

/** 6-knot pattern: project current wave to completion within the channel. */
function defaultImpulsePhases(sp) {
  return [
    [0.00, sp  ],
    [0.22, 0.88],
    [0.37, 0.22],
    [0.67, 1.20],
    [0.80, 0.72],
    [1.00, 1.05],
  ];
}

function extractChannelPivots(scenarioId, candles, dir) {
  const n = candles.length;
  if (!n) return [];
  const high = (c) => (dir > 0 ? c.high : c.low);
  const low  = (c) => (dir > 0 ? c.low  : c.high);

  if (scenarioId === 'wave-3') {
    const w3i = Math.max(0, Math.ceil(n * 0.62) - 1);
    const w4i = Math.max(0, Math.ceil(n * 0.76) - 1);
    return [
      { time: candles[w3i].time, price: high(candles[w3i]), label: '③', dir: dir > 0 ? 'up'   : 'down' },
      { time: candles[w4i].time, price: low(candles[w4i]),  label: '④', dir: dir > 0 ? 'down' : 'up'   },
      { time: candles[n-1].time, price: high(candles[n-1]), label: '⑤', dir: dir > 0 ? 'up'   : 'down' },
    ];
  }
  return [{ time: candles[n-1].time, price: high(candles[n-1]), label: '→', dir: dir > 0 ? 'up' : 'down' }];
}

// ---------------------------------------------------------------------------
// Free-path (scenarios that START a new phase — no active channel)
// ---------------------------------------------------------------------------

function buildFreePath(currentPrice, target, dir, dist, atr, lastTime, intervalSec, count, id) {
  let fracs;
  if (id === 'impulse-complete') {
    // A-B-C correction: A thrust (52%), B retrace (33%), C to target (100%)
    fracs = [0, 0.52, 0.33, 1.00];
  } else if (id === 'contracting-triangle' || id === 'expanding-triangle') {
    fracs = [0, 0.58, 1.00];
  } else {
    fracs = [0, 0.55, 1.00];
  }

  const waypoints = fracs.map(f => currentPrice + dir * dist * f);
  const candles   = buildSegments(waypoints, count, atr, lastTime, intervalSec);
  const n = candles.length;

  let projectedPivots = [];
  if (id === 'impulse-complete' && n > 3) {
    // Segment weights: |0.52|, |0.33-0.52|=0.19, |1-0.33|=0.67 → total 1.38
    const aIdx = Math.min(n - 1, Math.ceil(n * (0.52 / 1.38)));
    const bIdx = Math.min(n - 1, Math.ceil(n * ((0.52 + 0.19) / 1.38)));
    const dirA  = dir;
    const high  = (c) => (dirA > 0 ? c.high : c.low);
    const low   = (c) => (dirA > 0 ? c.low  : c.high);
    projectedPivots = [
      { time: candles[aIdx].time, price: low(candles[aIdx]),  label: 'A', dir: dirA > 0 ? 'down' : 'up'   },
      { time: candles[bIdx].time, price: high(candles[bIdx]), label: 'B', dir: dirA > 0 ? 'up'   : 'down' },
      { time: candles[n-1].time,  price: low(candles[n-1]),   label: 'C', dir: dirA > 0 ? 'down' : 'up'   },
    ];
  } else if (n > 0) {
    const high = (c) => (dir > 0 ? c.high : c.low);
    projectedPivots = [{ time: candles[n-1].time, price: high(candles[n-1]), label: '→', dir: dir > 0 ? 'up' : 'down' }];
  }

  return { candles, projectedPivots };
}

// ---------------------------------------------------------------------------
// Duration estimation from prior wave timing (Elliott proportionality)
// ---------------------------------------------------------------------------

function estimateCandleCount(id, pivots, intervalSec, dist, atr) {
  const ticks   = (a, b) => Math.abs(b - a) / intervalSec;
  const fallback = dist / (atr * 0.5);

  if (!pivots || pivots.length < 2) return fallback;
  const p = pivots, n = p.length;
  let raw;

  switch (id) {
    case 'wave-3': {
      const w1 = ticks(p[0].time, p[1].time);
      const w3 = w1 * 1.618;      // W3 ≈ 1.618× W1
      const w4 = w3 * 0.236;      // W4 brief (EW: stays above W1 high → shallow)
      const w5 = w1 * 1.0;        // W5 ≈ W1
      raw = w3 + w4 + w5;         // full remaining impulse count
      break;
    }
    case 'wave-5':
      raw = ticks(p[0].time, p[1].time) * 1.0;
      break;
    case 'impulse-complete':
      raw = ticks(p[0].time, p[n-1].time) * 0.5;
      break;
    case 'zigzag-c':
      raw = ticks(p[0].time, p[1].time) * 1.0;
      break;
    case 'flat-regular':
    case 'flat-expanded':
    case 'running-flat':
      raw = ticks(p[0].time, p[1].time) * 0.618;
      break;
    case 'contracting-triangle':
      raw = ticks(p[0].time, p[n-1].time) * 0.20;
      break;
    case 'expanding-triangle':
      raw = ticks(p[0].time, p[n-1].time) * 0.30;
      break;
    case 'double-zigzag':
      raw = n >= 4 ? ticks(p[2].time, p[3].time) * 1.0 : fallback;
      break;
    default:
      raw = ticks(p[0].time, p[n-1].time) * 0.5;
  }

  return (raw > 2 && raw < 500) ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }
function clamp01(x) { return Math.max(0, Math.min(0.5, x)); }

function phaseLerp(knots, progress) {
  for (let i = 1; i < knots.length; i++) {
    if (progress <= knots[i][0]) {
      const [t0, v0] = knots[i - 1], [t1, v1] = knots[i];
      const f = (progress - t0) / (t1 - t0);
      const e = f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
      return v0 + e * (v1 - v0);
    }
  }
  return knots[knots.length - 1][1];
}

function buildSegments(waypoints, totalCount, atr, lastTime, intervalSec) {
  const segDists = waypoints.slice(1).map((p, i) => Math.abs(p - waypoints[i]));
  const totalDist = segDists.reduce((a, b) => a + b, 0);
  if (totalDist === 0) return [];

  const result = [];
  for (let si = 0; si < segDists.length; si++) {
    const from = waypoints[si], to = waypoints[si + 1];
    const segCount = Math.max(1, Math.round(totalCount * segDists[si] / totalDist));
    let prevClose = from;
    for (let i = 0; i < segCount; i++) {
      const progress = (i + 1) / segCount;
      const e = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      const osc = Math.sin(result.length * 1.9) * atr * 0.07;
      const close = from + (to - from) * e + osc;
      const open = prevClose;
      const spread = atr * 0.055;
      result.push({
        time: lastTime + (result.length + 1) * intervalSec,
        open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close,
      });
      prevClose = close;
    }
  }
  return result;
}
