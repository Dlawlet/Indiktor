// Ghost-candle synthesis for predictive hypothesis visualisation.
//
// Each price path follows the expected Elliott Wave sub-structure for the stage:
//
//   formingB   → seg3 (B corrective)  →  seg3 (C corrective)  →  seg5 (2° impulse)
//   formingC   → seg3 (C corrective)                          →  seg5 (2° impulse)
//   awaiting2° →                                                 seg5 (2° impulse)
//
// Bias determines DIRECTION automatically (seg3/seg5 handle sign of move):
//   bull flat: A↑ B↓ C↑ 2°↓  (bull=correction in bullish swing within a down-trend)
//   bear flat: A↓ B↑ C↓ 2°↑
//
// Returns { candles: OHLC[], pivots: WayPoint[] }

// ── Primitives ────────────────────────────────────────────────────────────────

// Linear micro-segment: appends `nBars` candles into `out`.
function linSeg(out, t0, barDur, startP, endP, nBars) {
  const move = endP - startP;
  for (let i = 0; i < nBars; i++) {
    const a = i / nBars, b = (i + 1) / nBars;
    const o = startP + move * a;
    const c = startP + move * b;
    const wick = Math.max(Math.abs(c - o) * 0.22, Math.abs(move) / nBars * 0.04);
    out.push({ time: t0 + i * barDur, open: o, close: c,
               high: Math.max(o, c) + wick, low: Math.min(o, c) - wick });
  }
}

// 3-wave corrective (A-B-C): A=60%, B retraces 22% of total, C completes.
// Timing split: A=40%, B=18%, C=42%.
function seg3(out, t0, barDur, startP, endP, nBars) {
  if (nBars < 5) { linSeg(out, t0, barDur, startP, endP, nBars); return; }
  const move = endP - startP;
  const aEnd  = startP + move * 0.60;
  const bEnd  = aEnd   - move * 0.22;
  const nb    = [Math.max(2, Math.floor(nBars * 0.40)),
                 Math.max(1, Math.floor(nBars * 0.18)), 0];
  nb[2]       = Math.max(2, nBars - nb[0] - nb[1]);
  linSeg(out, t0,                              barDur, startP, aEnd, nb[0]);
  linSeg(out, t0 + nb[0] * barDur,             barDur, aEnd,   bEnd, nb[1]);
  linSeg(out, t0 + (nb[0] + nb[1]) * barDur,   barDur, bEnd,   endP, nb[2]);
}

// 5-wave impulse (1-2-3-4-5): Fibonacci-based sub-targets.
// Wave 3 is the largest. Wave 2 & 4 are shallow retracements.
// Timing split: 1=18%, 2=10%, 3=32%, 4=12%, 5=28%.
function seg5(out, t0, barDur, startP, endP, nBars) {
  if (nBars < 8) { linSeg(out, t0, barDur, startP, endP, nBars); return; }
  const move = endP - startP;
  const pts = [
    startP,
    startP + move * 0.23,   // w1 end
    startP + move * 0.15,   // w2 end (retrace ~35% of w1, stays on right side of w1 start)
    startP + move * 0.62,   // w3 end (biggest leg)
    startP + move * 0.53,   // w4 end (shallow: stays above w1 top for up, below for down)
    endP,                   // w5 end
  ];
  const nb = [
    Math.max(2, Math.floor(nBars * 0.18)),
    Math.max(1, Math.floor(nBars * 0.10)),
    Math.max(2, Math.floor(nBars * 0.32)),
    Math.max(1, Math.floor(nBars * 0.12)),
    0,
  ];
  nb[4] = Math.max(2, nBars - nb[0] - nb[1] - nb[2] - nb[3]);
  let t = t0;
  for (let seg = 0; seg < 5; seg++) {
    linSeg(out, t, barDur, pts[seg], pts[seg + 1], nb[seg]);
    t += nb[seg] * barDur;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function generateGhostCandles(hyp, livePrice, candles) {
  if (!candles?.length || !hyp?.anchor) return { candles: [], pivots: [] };

  const barDur = candles.length >= 2 ? candles[1].time - candles[0].time : 3600;
  const t0     = candles[candles.length - 1].time;
  const { O, A } = hyp.anchor;
  if (!O || !A) return { candles: [], pivots: [] };

  const legADur  = Math.abs(A.time - O.time);
  const legABars = Math.max(4, Math.round(legADur / barDur));
  const bull     = hyp.bias === 'bull';

  const soft     = hyp.zones?.invalidation?.soft;
  const tp       = hyp.zones?.tp;
  // For bull flat: 2° continuation is bearish → tpTarget = tp[0] (lower bound)
  // For bear flat: 2° continuation is bullish → tpTarget = tp[1] (upper bound)
  const tpTarget = tp ? (bull ? tp[0] : tp[1]) : null;

  const out      = [];   // ghost OHLC candles
  const waypoints = [];  // labelled turning points

  // cursor tracks current time and price tip of the ghost path
  let cur = { t: t0, p: livePrice };

  function advance(fn, bars, targetP, label) {
    fn(out, cur.t, barDur, cur.p, targetP, bars);
    cur.t += bars * barDur;
    cur.p  = targetP;
    waypoints.push({ time: cur.t - barDur, price: targetP, label });
  }

  if (hyp.stage === 'formingB') {
    // soft zone = where B should land
    const bTarget = soft ? (soft[0] + soft[1]) / 2 : null;
    if (bTarget == null) return { candles: [], pivots: [] };

    // 1. Current → B (corrective, 3-wave)
    advance(seg3, Math.max(5, Math.round(legABars * 0.90)), bTarget, 'B');

    // 2. B → C (corrective in opposite direction, C ≈ A.price for regular flat)
    const cEst = A.price;
    advance(seg3, Math.max(5, Math.round(legABars * 0.88)), cEst, 'C');

    // 3. C → 2° (impulsive continuation)
    if (tpTarget != null) {
      advance(seg5, Math.max(6, Math.round(legABars * 1.30)), tpTarget, '2°');
    }

  } else if (hyp.stage === 'formingC') {
    // soft zone = where C should land
    const cTarget = soft ? (soft[0] + soft[1]) / 2 : null;

    if (cTarget != null) {
      // 1. Current → C (corrective, 3-wave)
      advance(seg3, Math.max(5, Math.round(legABars * 0.85)), cTarget, 'C');
    }

    // 2. C → 2° (impulsive continuation)
    if (tpTarget != null) {
      advance(seg5, Math.max(6, Math.round(legABars * 1.25)), tpTarget, '2°');
    }

  } else {
    // awaiting2°: O/A/B/C all confirmed — show 5-wave continuation to TP
    if (tpTarget != null) {
      advance(seg5, Math.max(6, Math.round(legABars * 1.50)), tpTarget, '2°');
    }
  }

  if (!out.length) return { candles: [], pivots: [] };

  const projPivots = waypoints.map(wp => ({
    time:  wp.time,
    price: wp.price,
    label: wp.label,
    dir:   wp.price >= livePrice ? 'up' : 'down',
  }));

  return { candles: out, pivots: projPivots };
}
