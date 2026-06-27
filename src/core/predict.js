// Predictive engine — Phase 6a.
//
// Principle: we do NOT invent new arithmetic — we INVERT the post-mortem one.
// Post-mortem reads ratios from known prices; predictive fixes the bands and
// derives the prices the future must reach.
//
// Priority hierarchy (from spec):
//   1. Direction + pattern type
//   2. Price zones (completion / invalidation / TP)  ← the hard deliverable
//   3. Timing (soft, statistical, never a gate)

import { BANDS, membership } from './flats.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function sortRange(a, b) { return [Math.min(a, b), Math.max(a, b)]; }

function intersect([lo1, hi1], [lo2, hi2]) {
  const lo = Math.max(lo1, lo2);
  const hi = Math.min(hi1, hi2);
  return lo <= hi ? [lo, hi] : null;
}

function unionBounds(zones) {
  const flat = zones.filter(Boolean).flat();
  return flat.length ? [Math.min(...flat), Math.max(...flat)] : null;
}

// ── P.2  Band → price inversion helpers ──────────────────────────────────────

// B = A − rB · legA  →  B zone from rB band
function bZoneForType(A, legA, type) {
  const [lo,, hi] = BANDS[type].rB;
  return sortRange(A.price - hi * legA, A.price - lo * legA);
}

// C from pC band: C = A + pC · legA
// C from lenC band: C = B + lenC · legA  (sign(legA)·|legA| = legA)
// Completion zone = intersection of both constraints.
function cZoneForType(A, B, legA, type) {
  const [plo,, phi] = BANDS[type].pC;
  const pCzone = sortRange(A.price + plo * legA, A.price + phi * legA);

  const [llo,, lhi] = BANDS[type].lenC;
  const lCzone = sortRange(B.price + llo * legA, B.price + lhi * legA);

  return intersect(pCzone, lCzone);
}

// ── P.3  Measured-move TP ─────────────────────────────────────────────────────
//
//   TP = breakout(B) + dir · mm · |1° − O|
//   dir = −sign(legA)   (continuation is opposite to the correction)
//
// Returns [lo, hi] where lo=TP, hi=B for bull flat (TP below B),
//                        lo=B,  hi=TP for bear flat (TP above B).
// Falls back to |legA| × 1.0 when 1° is absent.

export function measuredMoveTP(hyp, mm = 1.0) {
  const { anchor, legA } = hyp;
  const { preO, O, B } = anchor;
  if (!B) return null;

  const amplitude = preO ? Math.abs(preO.price - O.price) : Math.abs(legA);
  const dir = -Math.sign(legA);
  const tp  = B.price + dir * mm * amplitude;
  return sortRange(tp, B.price);
}

// ── P.2  invertBands — the three zones per hypothesis ────────────────────────
//
// zone.completion   : where the forming pivot validates the type(s)
// zone.invalidation : { soft: [lo,hi] outer band limit, hard_1deg: price }
// zone.tp           : measured move from B (set when B is known)

export function invertBands(hyp) {
  const { stage, anchor, legA, typeBranch } = hyp;
  const { preO, O, A, B, C } = anchor;
  const zones = {
    invalidation: { hard_1deg: preO ? preO.price : null },
  };

  if (stage === 'formingB') {
    // All 4 types possible until rB is known.
    const completion = {};
    for (const t of Object.keys(BANDS)) {
      completion[t] = bZoneForType(A, legA, t);
    }
    zones.completion = completion;

    // Soft invalidation: B beyond the widest valid rB limits (0.18–3.5)
    // used as the non_flat gate in the post-mortem scanner.
    zones.invalidation.soft = sortRange(
      A.price - 3.5  * legA,
      A.price - 0.18 * legA,
    );

  } else if (stage === 'formingC') {
    const types = typeBranch;  // already narrowed to 2 by rB
    const completion = {};
    for (const t of types) {
      completion[t] = cZoneForType(A, B, legA, t);
    }
    zones.completion = completion;

    // Soft invalidation: C outside the union of all type completion zones
    // → price has left the band entirely (non_flat territory).
    zones.invalidation.soft = unionBounds(Object.values(completion));

    zones.tp = measuredMoveTP(hyp);

  } else {
    // awaiting2° — no more forming pivot within the flat itself.
    zones.completion = null;
    zones.tp = measuredMoveTP(hyp);
    // Soft: price reverses back through C against the continuation
    zones.invalidation.reversal = C ? C.price : null;
  }

  return zones;
}

// ── P.7  Predictive confidence ────────────────────────────────────────────────
//
//   confidence = stage_maturity × partial_band_fit × channel_cleanliness × fractal_consistency
//
// All four factors ∈ (0, 1] so the product is always ≤ the weakest factor.
// fractal_consistency is a stub (1.0) until Phase 6c.

const STAGE_MATURITY = {
  formingA:    0.20,
  formingB:    0.40,
  formingC:    0.65,
  'awaiting2°': 0.85,
};

function partialBandFit(hyp) {
  const { stage, typeBranch, rB } = hyp;
  if (stage === 'formingB' || rB == null) return 0.5;  // no ratio confirmed yet
  // rB is confirmed at formingC and awaiting2° → score it against each branch type
  let best = 0;
  for (const t of (typeBranch ?? Object.keys(BANDS))) {
    const f = membership(rB, ...BANDS[t].rB);
    if (f > best) best = f;
  }
  return best;
}

function channelCleanliness(hyp) {
  const { anchor, legA } = hyp;
  const { A, B } = anchor;
  if (!A || !B) return 0.6;
  // Ratio |AB| / |legA|: for a healthy flat, the B-leg is 50–130% of the A-leg.
  // Extremes (tiny retracement or massive overshoot) are less clean.
  const ratio = Math.abs(B.price - A.price) / (Math.abs(legA) + 1e-10);
  if (ratio >= 0.5 && ratio <= 1.5) return 0.8 + 0.2 * (1 - Math.abs(ratio - 1));
  return Math.max(0.15, 0.8 - 0.4 * Math.abs(ratio - 1));
}

export function predictiveConfidence(hyp) {
  const stageMat  = STAGE_MATURITY[hyp.stage] ?? 0.30;
  const bandFitV  = partialBandFit(hyp);
  const cleanness = channelCleanliness(hyp);
  const fractal   = 1.0;  // Phase 6c will replace this

  return {
    value: stageMat * bandFitV * cleanness * fractal,
    components: {
      stage_maturity:       stageMat,
      partial_band_fit:     bandFitV,
      channel_cleanliness:  cleanness,
      fractal_consistency:  fractal,
    },
  };
}

// ── P.1  Hypothesis enumeration ───────────────────────────────────────────────
//
// Tries the last `maxAnchors` confirmed pivots as O, using consecutive
// alternating pivots for A, B, C. Returns all valid hypotheses at all stages.
//
// Each returned hypothesis:
//   { stage, bias, typeBranch, anchor:{preO,O,A,B,C}, legA, rB?, zones, confidence }

export function enumerateHypotheses(pivots, livePrice, opts = {}) {
  const { maxAnchors = 4 } = opts;
  const n = pivots.length;
  if (n < 2) return [];

  const hyps = [];
  const oStart = Math.max(0, n - maxAnchors - 2);

  for (let oi = oStart; oi < n - 1; oi++) {
    const O    = pivots[oi];
    const preO = oi > 0 ? pivots[oi - 1] : null;
    const A    = pivots[oi + 1];
    const legA = A.price - O.price;
    if (Math.abs(legA) < 1e-10) continue;

    const bias = legA > 0 ? 'bull' : 'bear';
    const bi   = oi + 2;

    // ── formingB ──────────────────────────────────────────────────────────────
    if (bi >= n) {
      const hyp = {
        stage: 'formingB', bias,
        anchor: { preO, O, A, B: null, C: null },
        legA,
      };
      hyp.zones      = invertBands(hyp);
      hyp.confidence = predictiveConfidence(hyp);
      hyps.push(hyp);
      continue;
    }

    const B  = pivots[bi];
    const rB = (A.price - B.price) / legA;

    // B direction must oppose legA, and rB in valid range
    if (Math.sign(B.price - A.price) !== -Math.sign(legA)) continue;
    if (rB < 0.18 || rB > 3.5) continue;

    const typeBranch = rB <= 1
      ? ['regular', 'contracting']
      : ['running', 'expanding'];

    const ci = bi + 1;

    // ── formingC ──────────────────────────────────────────────────────────────
    if (ci >= n) {
      const hyp = {
        stage: 'formingC', bias, typeBranch,
        anchor: { preO, O, A, B, C: null },
        legA, rB,
      };
      hyp.zones      = invertBands(hyp);
      hyp.confidence = predictiveConfidence(hyp);
      hyps.push(hyp);
      continue;
    }

    const C = pivots[ci];
    if (Math.sign(C.price - B.price) !== Math.sign(legA)) continue;

    // ── awaiting2° ────────────────────────────────────────────────────────────
    const hyp = {
      stage: 'awaiting2°', bias, typeBranch,
      anchor: { preO, O, A, B, C },
      legA, rB,
    };
    hyp.zones      = invertBands(hyp);
    hyp.confidence = predictiveConfidence(hyp);
    hyps.push(hyp);
  }

  return hyps;
}
