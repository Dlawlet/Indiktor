/**
 * Ghost-candle forecast for selected Elliott Wave scenarios.
 *
 * CHANNEL-AWARE scenarios (wave-3/5, zigzag-C, flat-C, double-zigzag):
 *   Ghost candles oscillate WITHIN the channel drawn from anchorPivots,
 *   bouncing between the base line and the parallel with a 5-sub-wave
 *   impulse shape. The TP naturally falls at or just beyond the channel
 *   bound at the estimated end time.
 *
 * FREE-PATH scenarios (impulse-complete → A-B-C, triangle thrust, continuation):
 *   The pattern has COMPLETED; the next phase starts a new channel we can't
 *   draw yet. Path uses A-B-C or simple thrust sub-structure without channel
 *   constraints.
 *
 * Duration: estimated from the TIME of prior waves in anchorPivots using
 * Elliott proportionality rules (W3 ≈ 1.618× W1, zigzag-C ≈ A, etc.).
 */

// Scenarios where the ghost path stays inside the active channel.
const CHANNEL_AWARE = new Set([
  'wave-3', 'wave-5',
  'zigzag-c', 'flat-regular', 'flat-expanded', 'running-flat',
  'double-zigzag',
]);

export function projectGhostCandles({ scenario, anchorPivots, currentPrice, atr, lastTime, intervalSec }) {
  const target = scenario.targets[0]?.price;
  if (!target || !Number.isFinite(target)) return [];

  const dir = target > currentPrice ? 1 : -1;
  const dist = Math.abs(target - currentPrice);
  if (dist < atr * 0.3) return [];

  const count = clamp(
    estimateCandleCount(scenario.id, anchorPivots, intervalSec, dist, atr),
    6, 50,
  );

  if (CHANNEL_AWARE.has(scenario.id) && anchorPivots?.length >= 3) {
    return buildChannelPath(anchorPivots, currentPrice, target, atr, lastTime, intervalSec, count);
  }

  return buildFreePath(currentPrice, target, dir, dist, atr, lastTime, intervalSec, count, scenario.id);
}

// ---------------------------------------------------------------------------
// Channel-aware path: oscillates between the two channel lines.
// Phase 0 = base-line side (where p[0] and p[2] sit).
// Phase 1 = parallel side (where p[1] sits).
// The 5-sub-wave impulse pattern naturally describes how price bounces
// between these two bounds and finally extends through the outer bound to TP.
// ---------------------------------------------------------------------------

function buildChannelPath(anchorPivots, currentPrice, target, atr, lastTime, intervalSec, count) {
  const p = anchorPivots.slice(-3);
  if (p[2].time <= p[0].time) return [];

  // Channel parametrisation
  const slope = (p[2].price - p[0].price) / (p[2].time - p[0].time); // price per second
  const lineAt = (t) => p[0].price + slope * (t - p[0].time);
  const offset = p[1].price - lineAt(p[1].time); // signed channel width; p[1] is on the PARALLEL
  if (offset === 0) return [];

  // Convert a (time, phase) pair to an actual price.
  // phase 0 → base line, phase 1 → parallel, phase >1 → extends beyond parallel (EW extension).
  const priceAt = (t, phase) => lineAt(t) + phase * offset;

  // Starting phase: where is currentPrice inside the channel?
  // Should be ≈ 0 (we're at the base-line end = p[2]) but may deviate slightly.
  const startPhase = clamp01((currentPrice - lineAt(lastTime)) / offset);

  // 5-sub-wave phase pattern – progress → channel phase:
  //   sub-W1 approaches the parallel, sub-W2 retraces, sub-W3 EXTENDS beyond
  //   the parallel (Elliott extension), sub-W4 retraces, sub-W5 lands at TP.
  const PHASES = [
    [0.00, startPhase],  // start (at base line)
    [0.22, 0.88],         // sub-W1: nears parallel
    [0.37, 0.22],         // sub-W2: retrace, stays above base
    [0.67, 1.20],         // sub-W3: EXTENDS beyond parallel (the powerful wave)
    [0.80, 0.72],         // sub-W4: retrace, stays above parallel
    [1.00, 1.05],         // sub-W5: lands at/just beyond parallel = TP
  ];

  const result = [];
  let prevClose = currentPrice;

  for (let i = 0; i < count; i++) {
    const t = lastTime + (i + 1) * intervalSec;
    const progress = (i + 1) / count;
    const phase = phaseLerp(PHASES, progress);

    // Micro-oscillation for candle texture (deterministic, no Math.random)
    const osc = Math.sin(i * 2.13 + phase) * atr * 0.04;
    const close = priceAt(t, phase) + osc;
    const open = prevClose;
    const spread = atr * 0.055;

    result.push({
      time: t, open,
      high: Math.max(open, close) + spread,
      low:  Math.min(open, close) - spread,
      close,
    });
    prevClose = close;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Free path: used for scenarios that START a new phase (not within an
// existing channel). Sub-wave waypoints as cumulative % of net distance.
// ---------------------------------------------------------------------------

function buildFreePath(currentPrice, target, dir, dist, atr, lastTime, intervalSec, count, id) {
  let fracs;
  if (id === 'impulse-complete') {
    // Correction A-B-C: A thrust (52%), B partial retrace (33%), C to target (100%)
    fracs = [0, 0.52, 0.33, 1.00];
  } else if (id === 'contracting-triangle' || id === 'expanding-triangle') {
    // Fast post-triangle thrust with brief pause
    fracs = [0, 0.58, 1.00];
  } else {
    // Continuation baseline
    fracs = [0, 0.55, 1.00];
  }

  const waypoints = fracs.map(f => currentPrice + dir * dist * f);
  return buildSegments(waypoints, count, atr, lastTime, intervalSec);
}

// ---------------------------------------------------------------------------
// Duration estimation from prior wave timing (Elliott proportionality).
// ---------------------------------------------------------------------------

function estimateCandleCount(id, pivots, intervalSec, dist, atr) {
  const ticks = (a, b) => Math.abs(b - a) / intervalSec;
  const fallback = dist / (atr * 0.5);

  if (!pivots || pivots.length < 2) return fallback;
  const p = pivots;
  const n = p.length;
  let raw;

  switch (id) {
    case 'wave-3':
      raw = ticks(p[0].time, p[1].time) * 1.618; // W3 ≈ 1.618× W1
      break;
    case 'wave-5':
      raw = ticks(p[0].time, p[1].time) * 1.0;   // W5 ≈ W1
      break;
    case 'impulse-complete':
      raw = ticks(p[0].time, p[n - 1].time) * 0.5; // correction ≈ 50% of impulse
      break;
    case 'zigzag-c':
      raw = ticks(p[0].time, p[1].time) * 1.0;   // C ≈ A
      break;
    case 'flat-regular':
    case 'flat-expanded':
    case 'running-flat':
      raw = ticks(p[0].time, p[1].time) * 0.618; // flat C ≈ 0.618× A (B consumed the time)
      break;
    case 'contracting-triangle':
      raw = ticks(p[0].time, p[n - 1].time) * 0.20; // thrust ≈ 20% of triangle
      break;
    case 'expanding-triangle':
      raw = ticks(p[0].time, p[n - 1].time) * 0.30;
      break;
    case 'double-zigzag':
      raw = n >= 4 ? ticks(p[2].time, p[3].time) * 1.0 : fallback; // Y-C ≈ Y-A
      break;
    default:
      raw = ticks(p[0].time, p[n - 1].time) * 0.5;
  }

  // Sanity gate: degenerate pivot timing → distance fallback
  return (raw > 2 && raw < 500) ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }
function clamp01(x) { return Math.max(0, Math.min(0.5, x)); } // start phase stays near base

/** Linear-with-ease-in-out interpolation through a series of [progress, value] knots. */
function phaseLerp(knots, progress) {
  for (let i = 1; i < knots.length; i++) {
    if (progress <= knots[i][0]) {
      const [t0, v0] = knots[i - 1];
      const [t1, v1] = knots[i];
      const f = (progress - t0) / (t1 - t0);
      const e = f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
      return v0 + e * (v1 - v0);
    }
  }
  return knots[knots.length - 1][1];
}

/** Generate candles along a series of absolute price waypoints. */
function buildSegments(waypoints, totalCount, atr, lastTime, intervalSec) {
  const segDists = waypoints.slice(1).map((p, i) => Math.abs(p - waypoints[i]));
  const totalDist = segDists.reduce((a, b) => a + b, 0);
  if (totalDist === 0) return [];

  const result = [];

  for (let si = 0; si < segDists.length; si++) {
    const from = waypoints[si];
    const to   = waypoints[si + 1];
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
