/**
 * Ghost-candle path projection for a selected Elliott Wave scenario.
 *
 * Duration is estimated from the TIME of prior waves recorded in anchorPivots
 * (Elliott proportionality: W3 ≈ 1.618× W1, correction ≈ 0.5× impulse, etc.).
 *
 * Sub-wave structure is driven by scenario.pattern:
 *   impulse    → 5 sub-waves (up, small down, big up, small down, final up)
 *   correction → A-B-C (thrust, partial retrace, thrust to target)
 *   continuation → simple thrust with brief pause
 */
export function projectGhostCandles({ scenario, anchorPivots, currentPrice, atr, lastTime, intervalSec }) {
  const targetPrice = scenario.targets[0]?.price;
  if (!targetPrice || !Number.isFinite(targetPrice)) return [];

  const dir = targetPrice > currentPrice ? 1 : -1;
  const dist = Math.abs(targetPrice - currentPrice);
  if (dist < atr * 0.3) return [];

  const count = clamp(estimateCandleCount(scenario.id, anchorPivots, intervalSec, dist, atr), 6, 50);
  const fracs = subStructureFracs(scenario.pattern);
  const waypoints = fracs.map(f => currentPrice + dir * dist * f);

  return buildSegments(waypoints, count, atr, lastTime, intervalSec);
}

// ---------------------------------------------------------------------------

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

/** Estimate how many candles the scenario should take, using prior wave durations. */
function estimateCandleCount(id, pivots, intervalSec, dist, atr) {
  const ticks = (a, b) => Math.abs(b - a) / intervalSec;
  const fallback = dist / (atr * 0.5);
  if (!pivots || pivots.length < 2) return fallback;

  const p = pivots;
  const len = p.length;
  let raw;

  switch (id) {
    case 'wave-3':
      // Wave 3 ≈ 1.618× Wave 1 in time
      raw = ticks(p[0].time, p[1].time) * 1.618;
      break;
    case 'wave-5':
      // Wave 5 ≈ Wave 1 in time
      raw = ticks(p[0].time, p[1].time) * 1.0;
      break;
    case 'impulse-complete':
      // A-B-C correction ≈ 50% of the full impulse's time span
      raw = ticks(p[0].time, p[len - 1].time) * 0.5;
      break;
    case 'zigzag-c':
      // C ≈ A in time
      raw = ticks(p[0].time, p[1].time) * 1.0;
      break;
    case 'flat-regular':
    case 'flat-expanded':
    case 'running-flat':
      // Flat C ≈ 0.618× A in time (flats spend more time in B)
      raw = ticks(p[0].time, p[1].time) * 0.618;
      break;
    case 'contracting-triangle':
      // Post-E thrust is fast: ~20% of the whole triangle duration
      raw = ticks(p[0].time, p[len - 1].time) * 0.20;
      break;
    case 'expanding-triangle':
      raw = ticks(p[0].time, p[len - 1].time) * 0.30;
      break;
    case 'double-zigzag':
      // Y-C ≈ Y-A in time; Y-A is p[2]→p[3]
      raw = len >= 4 ? ticks(p[2].time, p[3].time) * 1.0 : fallback;
      break;
    default:
      // Continuation: project half the last swing's duration
      raw = ticks(p[0].time, p[len - 1].time) * 0.5;
  }

  // Sanity check: if timing data is degenerate, fall back to distance estimate
  return (raw > 2 && raw < 500) ? raw : fallback;
}

/**
 * Cumulative price fracs as % of total net distance [0 → 1].
 * Values that dip below the previous one represent counter-wave retraces.
 *
 * Example impulse UP: price goes to 30% of target, retraces to 18%, extends
 * to 67%, retraces to 54%, then completes to 100%.
 */
function subStructureFracs(pattern) {
  if (pattern === 'impulse') {
    // 5-sub-wave: W1(30%) W2-retrace(18%) W3(67%) W4-retrace(54%) W5(100%)
    return [0, 0.30, 0.18, 0.67, 0.54, 1.00];
  }
  if (pattern === 'correction') {
    // A-B-C: A thrust(52%) B retrace(33%) C completes(100%)
    return [0, 0.52, 0.33, 1.00];
  }
  // continuation / triangle breakout: thrust, brief pause, complete
  return [0, 0.55, 1.00];
}

/** Build candle OHLC data along a series of price waypoints. */
function buildSegments(waypoints, totalCount, atr, lastTime, intervalSec) {
  // Allocate candles per segment proportional to segment price distance
  const segDists = waypoints.slice(1).map((p, i) => Math.abs(p - waypoints[i]));
  const totalDist = segDists.reduce((a, b) => a + b, 0);
  if (totalDist === 0) return [];

  const result = [];

  for (let si = 0; si < segDists.length; si++) {
    const from = waypoints[si];
    const to = waypoints[si + 1];
    const segCount = Math.max(1, Math.round(totalCount * segDists[si] / totalDist));
    let prevClose = from;

    for (let i = 0; i < segCount; i++) {
      const progress = (i + 1) / segCount;
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

      // Deterministic micro-oscillation so candles have natural texture
      const oscillation = Math.sin(result.length * 1.9 + si * 0.7) * atr * 0.10;
      const close = from + (to - from) * eased + oscillation;
      const open = prevClose;
      const spread = atr * 0.06;
      const high = Math.max(open, close) + spread;
      const low  = Math.min(open, close) - spread;

      result.push({
        time: lastTime + result.length * intervalSec + intervalSec,
        open, high, low, close,
      });
      prevClose = close;
    }
  }

  return result;
}
