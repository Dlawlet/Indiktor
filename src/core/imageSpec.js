// ⑥ Canonical Wave "image" grammar — pure geometry, no rendering.
//
// A flat reads as three pieces:
//   1°→O  entry impulse   (thick, continuation-coloured)
//   tunnel = two rails O→B and A→C  (same-parity pivots; neutral/dim stroke).
//           Its shape emerges from the pivots themselves: parallel (regular/
//           running), diverging (expanding), contracting (contracting).
//   C→2°  exit impulse    (thick, continuation-coloured)
//
// In prediction mode the not-yet-confirmed parts are PROJECTED and flagged
// `dashed:true`: the A→C rail runs to the completion zone, C→2° to the TP zone.
// Respecting the ④b gate, a forming hypothesis only yields projected geometry
// when its type is determined (typeBranch present); a fork yields one projected
// rail + impulse PER branch (weighted), never an average.
//
// Output (per selection): { type, segments[], zones[], points[] }
//   segment: { role:'impulse'|'rail', from:{time,price}, to:{time,price}, dashed, weight }
//   zone:    { t1, t2, lo, hi }                  (projected completion / TP band)
//   point:   { time, price, label, above }       (pivot label markers; real pivots only)
//
// Colour is applied by the renderer (impulse = continuation colour, rail = dim).

import { BANDS, membership } from './flats.js';

const pt  = (p) => ({ time: p.time, price: p.price });
const seg = (role, from, to, dashed, weight = 1) => ({ role, from: pt(from), to: pt(to), dashed, weight });

function neighborBefore(pivots, time) {
  let best = null;
  for (const p of pivots) { if (p.time < time) best = p; else break; }
  return best;
}
function neighborAfter(pivots, time) {
  for (const p of pivots) if (p.time > time) return p;
  return null;
}

// Pivot label markers for the real (confirmed) pivots. `bull` flips above/below
// so labels sit outside the structure (highs above, lows below).
function labelPoints({ oneDeg, O, A, B, C, twoDeg, bull }) {
  const pts = [];
  const add = (p, label, high) => { if (p) pts.push({ time: p.time, price: p.price, label, above: bull ? high : !high }); };
  add(oneDeg, '1°', true);
  add(O, 'O', false);
  add(A, 'A', true);
  add(B, 'B', false);
  add(C, 'C', true);
  add(twoDeg, '2°', false);
  return pts;
}

// ── Historical (completed) flat ───────────────────────────────────────────────
export function patternImageSpec(pattern, pivots = []) {
  const O = pattern.aStart, A = pattern.aEnd, B = pattern.bEnd, C = pattern.cEnd;
  if (!O || !A || !B || !C) return null;

  const oneDeg = neighborBefore(pivots, O.time);
  const twoDeg = neighborAfter(pivots, C.time);
  const bull   = pattern.bias === 'bull';

  const segments = [];
  if (oneDeg) segments.push(seg('impulse', oneDeg, O, false));
  segments.push(seg('rail', O, B, false));   // lower/upper rail
  segments.push(seg('rail', A, C, false));   // opposite rail
  if (twoDeg) segments.push(seg('impulse', C, twoDeg, false));

  return { type: pattern.type, segments, zones: [],
           points: labelPoints({ oneDeg, O, A, B, C, twoDeg, bull }) };
}

// ── Predictive hypothesis ─────────────────────────────────────────────────────
export function hypImageSpec(hyp) {
  const { preO: oneDeg, O, A, B, C } = hyp.anchor ?? {};
  if (!O || !A) return null;

  const legDur   = Math.abs(A.time - O.time) || 1;
  const bull     = hyp.bias === 'bull';
  const tp       = hyp.zones?.tp;
  const tpTarget = tp ? (bull ? tp[0] : tp[1]) : null;

  const segments = [];
  const zones    = [];
  if (oneDeg) segments.push(seg('impulse', oneDeg, O, false));
  if (B) segments.push(seg('rail', O, B, false));

  if (hyp.stage === 'awaiting2°' && C) {
    segments.push(seg('rail', A, C, false));                 // A→C confirmed
    if (tpTarget != null) {
      const tpPt = { time: C.time + legDur, price: tpTarget };
      segments.push(seg('impulse', C, tpPt, true));          // C→2° projected
      zones.push({ t1: C.time, t2: tpPt.time, lo: tp[0], hi: tp[1] });
    }
    return { type: hyp.typeBranch?.[0] ?? null, segments, zones,
             points: labelPoints({ oneDeg, O, A, B, C, bull }) };
  }

  if (hyp.stage === 'formingC' && B) {
    // ④b gate: only determined types get projected geometry; draw each branch.
    const branch     = hyp.typeBranch ?? [];
    const completion = hyp.zones?.completion ?? {};
    const memOf      = (t) => membership(hyp.rB, ...BANDS[t].rB);
    const memSum     = branch.reduce((s, t) => s + memOf(t), 0) || 1;

    for (const t of branch) {
      const zone = completion[t];
      if (!zone) continue;
      const w     = memOf(t) / memSum;
      const cPt   = { time: B.time + legDur, price: (zone[0] + zone[1]) / 2 };
      segments.push(seg('rail', A, cPt, true, w));            // A→C projected (per branch)
      zones.push({ t1: A.time, t2: cPt.time, lo: zone[0], hi: zone[1] });
      if (tpTarget != null) {
        const tpPt = { time: cPt.time + legDur, price: tpTarget };
        segments.push(seg('impulse', cPt, tpPt, true, w));    // C→2° projected (per branch)
      }
    }
    if (tpTarget != null && tp) {
      const t1 = B.time + legDur, t2 = t1 + legDur;
      zones.push({ t1, t2, lo: tp[0], hi: tp[1] });
    }
    return { type: null, segments, zones,                     // fork → no single type
             points: labelPoints({ oneDeg, O, A, B, bull }) };
  }

  return null; // formingB / formingA — gated (no projected grammar)
}
