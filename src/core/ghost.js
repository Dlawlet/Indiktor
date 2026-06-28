// Ghost-candle synthesis for predictive hypothesis visualisation.
//
// ④b GATE: a hypothesis only gets PROJECTED geometry once its type is
// determined — i.e. it carries a `typeBranch` (formingC fork, or awaiting2°).
// Open stages (formingA / formingB) return no paths at all: the chart then shows
// only the confirmed pivots + zones, never a fabricated curve that is "no pattern".
//
// For a formingC FORK (two candidate types) we emit TWO distinct paths — one per
// branch, each targeting that type's own completion zone — never an average.
// Each path carries a `weight` (normalised rB-membership) used for opacity.
//
// Each path: { candles: OHLC[], pivots: WayPoint[], type: string, weight: number }
// generateGhostPaths(hyp, livePrice, candles) → path[]

import { BANDS, membership } from './flats.js';

// ── OHLC primitives ───────────────────────────────────────────────────────────

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
function seg3(out, t0, barDur, startP, endP, nBars) {
  if (nBars < 5) { linSeg(out, t0, barDur, startP, endP, nBars); return; }
  const move = endP - startP;
  const aEnd = startP + move * 0.60;
  const bEnd = aEnd   - move * 0.22;
  const nb   = [Math.max(2, Math.floor(nBars * 0.40)),
                Math.max(1, Math.floor(nBars * 0.18)), 0];
  nb[2]      = Math.max(2, nBars - nb[0] - nb[1]);
  linSeg(out, t0,                            barDur, startP, aEnd, nb[0]);
  linSeg(out, t0 + nb[0] * barDur,           barDur, aEnd,   bEnd, nb[1]);
  linSeg(out, t0 + (nb[0] + nb[1]) * barDur, barDur, bEnd,   endP, nb[2]);
}

// 5-wave impulse (1-2-3-4-5) with Fibonacci-ish sub-targets.
function seg5(out, t0, barDur, startP, endP, nBars) {
  if (nBars < 8) { linSeg(out, t0, barDur, startP, endP, nBars); return; }
  const move = endP - startP;
  const pts = [startP, startP + move * 0.23, startP + move * 0.15,
               startP + move * 0.62, startP + move * 0.53, endP];
  const nb = [Math.max(2, Math.floor(nBars * 0.18)), Math.max(1, Math.floor(nBars * 0.10)),
              Math.max(2, Math.floor(nBars * 0.32)), Math.max(1, Math.floor(nBars * 0.12)), 0];
  nb[4] = Math.max(2, nBars - nb[0] - nb[1] - nb[2] - nb[3]);
  let t = t0;
  for (let s = 0; s < 5; s++) { linSeg(out, t, barDur, pts[s], pts[s + 1], nb[s]); t += nb[s] * barDur; }
}

// Build a path from `startPrice` through a sequence of legs.
//   legs: [{ to, label, fn, bars }]
function buildPath(t0, barDur, startPrice, legs) {
  const out = [];
  let t = t0, p = startPrice;
  const pivots = [];
  for (const leg of legs) {
    leg.fn(out, t, barDur, p, leg.to, leg.bars);
    t += leg.bars * barDur;
    p  = leg.to;
    pivots.push({ time: t - barDur, price: leg.to, label: leg.label,
                  dir: leg.to >= startPrice ? 'up' : 'down' });
  }
  return { candles: out, pivots };
}

// ── Main: per-branch projected paths ──────────────────────────────────────────

export function generateGhostPaths(hyp, livePrice, candles) {
  if (!candles?.length || !hyp?.anchor) return [];

  // ④b gate — no determined type ⇒ no projected geometry.
  const branch = hyp.typeBranch;
  if (!branch?.length) return [];

  const barDur = candles.length >= 2 ? candles[1].time - candles[0].time : 3600;
  const t0     = candles[candles.length - 1].time;
  const { O, A } = hyp.anchor;
  if (!O || !A) return [];

  const legABars = Math.max(4, Math.round(Math.abs(A.time - O.time) / barDur));
  const bull     = hyp.bias === 'bull';
  const tp       = hyp.zones?.tp;
  const tpTarget = tp ? (bull ? tp[0] : tp[1]) : null;

  // awaiting2°: O-A-B-C confirmed → project only the 2° impulse (current → TP).
  if (hyp.stage === 'awaiting2°') {
    if (tpTarget == null) return [];
    const p = buildPath(t0, barDur, livePrice, [
      { to: tpTarget, label: '2°', fn: seg5, bars: Math.max(6, Math.round(legABars * 1.5)) },
    ]);
    return [{ ...p, type: branch.length === 1 ? branch[0] : 'flat', weight: 1 }];
  }

  // formingC fork: one path per candidate type → its own completion zone, then TP.
  if (hyp.stage === 'formingC') {
    const completion = hyp.zones?.completion ?? {};
    const memOf = (t) => membership(hyp.rB, ...BANDS[t].rB);
    const memSum = branch.reduce((s, t) => s + memOf(t), 0) || 1;

    return branch.map((t) => {
      const zone = completion[t];
      if (!zone) return null;
      const cTarget = (zone[0] + zone[1]) / 2;
      const legs = [{ to: cTarget, label: `C·${t[0].toUpperCase()}`, fn: seg3,
                      bars: Math.max(5, Math.round(legABars * 0.85)) }];
      if (tpTarget != null) {
        legs.push({ to: tpTarget, label: '2°', fn: seg5,
                    bars: Math.max(6, Math.round(legABars * 1.25)) });
      }
      const p = buildPath(t0, barDur, livePrice, legs);
      return { ...p, type: t, weight: memOf(t) / memSum };
    }).filter(Boolean);
  }

  return [];
}
