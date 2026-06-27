// Phase 6c: multi-TF constraint propagation (spec §P.5).
//
// Three concerns are addressed here:
//   1. classifyRelation / applyFractalConstraints  — P.5 concordant/contradictory/impossible
//   2. scaleStability   — real implementation (k±Δ re-run), replaces the 0.6 stub
//   3. nestingCoherence — real implementation (sub-TF leg alignment), replaces the 0.6 stub
//
// None of these functions mutate their inputs; they return new objects.

import { zigzag } from './zigzag.js';

// ── P.5  Relation classification ─────────────────────────────────────────────
//
// "Sens" of a flat = direction of its main trend (continuation after the flat).
//   Bull flat (legA > 0, correction UP)  → main trend is BEARISH, TP goes DOWN.
//   Bear flat (legA < 0, correction DOWN) → main trend is BULLISH, TP goes UP.
//
// Concordant : h and g share the same main-trend direction (h.bias === g.bias).
//              A lower-TF bull flat nested inside a higher-TF bull flat both
//              describe a correction in the same bearish trend.
//
// Contradictory : h's TP would require crossing g's hard_1deg invalidation level.
//                 e.g. h is a bear flat (bullish TP going UP) inside a bull g
//                 whose hard_1deg sits below h's TP ceiling → kills g.
//
// Impossible : h's own hard invalidation has already been crossed by g's
//              confirmed price action (currentPrice provided via opts).

export function classifyRelation(h, g) {
  if (!g) return 'neutral';

  // Concordant: same correction direction within same main trend
  if (h.bias === g.bias) return 'concordant';

  // Different bias — check if h's TP would cross g's hard invalidation
  const gInval = g.zones?.invalidation?.hard_1deg;
  const hTP    = h.zones?.tp;

  if (hTP != null && gInval != null) {
    const [tpLo, tpHi] = hTP;
    // bull g: alive while price < g's 1° (1° is a high).  Killed if price > 1°.
    // bear h has a bullish TP going UP → contradictory if TP goes above g's 1°.
    if (g.bias === 'bull' && h.bias === 'bear' && tpHi > gInval) return 'contradictory';

    // bear g: alive while price > g's 1° (1° is a low).  Killed if price < 1°.
    // bull h has a bearish TP going DOWN → contradictory if TP goes below g's 1°.
    if (g.bias === 'bear' && h.bias === 'bull' && tpLo < gInval) return 'contradictory';
  }

  return 'neutral';
}

// ── P.5  Apply fractal constraints ───────────────────────────────────────────
//
// opts:
//   boostFactor    (1.30)  — multiply fractal_consistency when concordant
//   maxBoost       (2.00)  — cap for fractal_consistency (spec: boost plafonné)
//   penaltyFactor  (0.50)  — multiply fractal_consistency when contradictory
//   pruneThreshold (0.15)  — drop contradictory scenarios below this confidence
//   currentPrice   (null)  — if provided, detect impossible scenarios directly
//
// Returns: { kept: Hypothesis[], alternatives: Hypothesis[] }
//   alternatives: contradictory scenarios flagged with goal_invalidates=true

export function applyFractalConstraints(hyps, goal, opts = {}) {
  const {
    boostFactor    = 1.30,
    maxBoost       = 2.00,
    penaltyFactor  = 0.50,
    pruneThreshold = 0.15,
    currentPrice   = null,
  } = opts;

  if (!goal) return { kept: hyps.map(h => ({ ...h })), alternatives: [] };

  const kept        = [];
  const alternatives = [];

  for (const h of hyps) {
    // ── Impossible check (requires current price) ────────────────────────────
    if (currentPrice != null) {
      const hInval = h.zones?.invalidation?.hard_1deg;
      if (hInval != null) {
        const crossed = h.bias === 'bull'
          ? currentPrice > hInval   // bull flat invalidated: price rose above 1°
          : currentPrice < hInval;  // bear flat invalidated: price fell below 1°
        if (crossed) continue;      // drop — impossible
      }
    }

    const rel = classifyRelation(h, goal);
    const updated = cloneHyp(h);
    updated.fractalRelation = rel;

    if (rel === 'concordant') {
      applyFC(updated, boostFactor, maxBoost);
      kept.push(updated);

    } else if (rel === 'contradictory') {
      applyFC(updated, penaltyFactor, 1.0);
      updated.goal_invalidates = true;
      alternatives.push(updated);
      // Keep contradictory if confidence is still meaningful after penalty
      if (updated.confidence.value >= pruneThreshold) kept.push(updated);

    } else {
      // neutral — unchanged
      kept.push(updated);
    }
  }

  return { kept, alternatives };
}

// Update fractal_consistency component and recompute confidence.value
function applyFC(hyp, factor, cap) {
  const old  = hyp.confidence.components.fractal_consistency ?? 1.0;
  const nfc  = Math.min(cap, old * factor);
  // confidence.value is a product of all components; scale proportionally
  const newV = Math.min(1.0, hyp.confidence.value * (nfc / (old || 1e-10)));
  hyp.confidence = {
    ...hyp.confidence,
    value: newV,
    components: { ...hyp.confidence.components, fractal_consistency: nfc },
  };
}

function cloneHyp(h) {
  return {
    ...h,
    anchor:     { ...h.anchor },
    zones:      h.zones ? {
      ...h.zones,
      completion:   h.zones.completion ? { ...h.zones.completion } : null,
      invalidation: h.zones.invalidation ? { ...h.zones.invalidation } : null,
    } : null,
    confidence: {
      ...h.confidence,
      components: { ...h.confidence.components },
    },
  };
}

// ── Scale stability (real, replaces 0.6 stub) ─────────────────────────────────
//
// Re-runs zigzag at k−Δ and k+Δ on the same candles and checks whether the
// hypothesis's O pivot (identified by its candle index) still survives in both.
// A pivot "survives" if a pivot of the same type appears within ±tolerance
// candles of the original O.index.
//
// Returns 1.0 both survive, 0.60 one survives, 0.25 neither (artifact of k).
// Returns 0.60 (neutral) when candles are absent.

export function scaleStability(candles, hyp, baseK = 3, delta = 0.5) {
  if (!candles?.length) return 0.60;

  const O     = hyp.anchor?.O;
  const A     = hyp.anchor?.A;
  if (!O || O.index == null) return 0.60;

  const span      = A ? Math.abs((A.index ?? 0) - O.index) : 10;
  const tolerance = Math.max(2, Math.ceil(span * 0.15));

  const survived = (pivots) =>
    pivots.some(p =>
      p.index != null &&
      Math.abs(p.index - O.index) <= tolerance &&
      p.type === O.type,
    );

  try {
    const pvLow  = zigzag(candles, { atrMult: Math.max(0.5, baseK - delta), atrPeriod: 14 })
                     .filter(p => !p.tentative);
    const pvHigh = zigzag(candles, { atrMult: baseK + delta, atrPeriod: 14 })
                     .filter(p => !p.tentative);

    const lo = survived(pvLow);
    const hi = survived(pvHigh);

    if (lo && hi) return 1.00;
    if (lo || hi) return 0.60;
    return 0.25;
  } catch {
    return 0.60;
  }
}

// ── Nesting coherence (real, replaces 0.6 stub) ───────────────────────────────
//
// Checks that sub-TF hypotheses fall within the correct legs of `hyp` and
// carry the expected bias:
//   Leg A (O → A time): same bias as hyp (correction moves in leg direction)
//   Leg B (A → B time): opposite bias    (counter-move back)
//
// Score = 0.40 (all wrong) … 1.0 (all correct).
// Returns 0.60 (neutral) when no sub-hypotheses are provided.

export function nestingCoherence(hyp, subHyps) {
  if (!subHyps?.length) return 0.60;

  const { O, A, B } = hyp.anchor;
  if (!O || !A) return 0.60;

  const legABias = hyp.bias;
  const legBBias = hyp.bias === 'bull' ? 'bear' : 'bull';

  let correct = 0;
  let total   = 0;

  for (const s of subHyps) {
    const sO = s.anchor?.O;
    if (!sO) continue;

    const inLegA = A.time != null && sO.time >= O.time && sO.time <= A.time;
    const inLegB = B?.time != null && A.time != null && sO.time > A.time && sO.time <= B.time;

    if (inLegA) {
      correct += s.bias === legABias ? 1 : 0;
      total++;
    } else if (inLegB) {
      correct += s.bias === legBBias ? 1 : 0;
      total++;
    }
    // sub-hyps outside known legs are ignored (not enough data to judge)
  }

  if (!total) return 0.55;  // sub-hyps exist but none fall within known legs
  return 0.40 + 0.60 * (correct / total);
}

// ── withFractal — post-processing step ───────────────────────────────────────
//
// Enriches a list of hypotheses (from enumerateHypotheses) with the real
// scale_stability and nesting_coherence values, then applies a higher-TF goal
// constraint if provided.
//
// Usage (in scanner or app):
//   let hyps = enumerateHypotheses(pivots, livePrice);
//   hyps = withFractal(hyps, { candles, baseK, subHyps, goal });

export function withFractal(hyps, opts = {}) {
  const {
    candles = null, baseK = 3, delta = 0.5,
    subHyps = null, goal = null, currentPrice = null,
  } = opts;

  // Enrich each hyp with real scale_stability and nesting_coherence
  const enriched = hyps.map(h => {
    const ss  = scaleStability(candles, h, baseK, delta);
    const nc  = nestingCoherence(h, subHyps);

    // Recompute confidence with real components replacing the stubs.
    // The two stubs were 0.6 (neutral); we replace them proportionally.
    const oldSS = h.confidence.components.scale_stability  ?? 0.60;
    const oldNC = h.confidence.components.nesting_coherence ?? 0.60;
    const ratio = (ss * nc) / ((oldSS * oldNC) || 1e-10);
    const newV  = Math.min(1.0, h.confidence.value * ratio);

    return {
      ...h,
      confidence: {
        ...h.confidence,
        value: newV,
        components: {
          ...h.confidence.components,
          scale_stability:    ss,
          nesting_coherence:  nc,
        },
      },
    };
  });

  // Apply higher-TF constraints
  const { kept } = applyFractalConstraints(enriched, goal, { currentPrice });
  return kept;
}
