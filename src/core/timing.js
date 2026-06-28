// Phase 6e — duration priors for Elliott Wave flat legs (spec §P.8).
//
// Each leg's bar count is benchmarked against leg-A duration:
//   legB expected:  [0.382, 1.618] × legA  (Fibonacci sandwich)
//   legC expected:  [0.500, 2.000] × legA  (wider — C is often extended)
//
// Outside the expected window the score decays linearly toward a floor of 0.30
// (soft, not a hard kill). Score = 1.0 everywhere inside the window.
//
// Usage:
//   let hyps = enumerateHypotheses(pivots, livePrice);
//   hyps = withTiming(hyps, currentBarIndex, { windows, tf });  // windows optional
//
// When the ① loop has learned empirical duration windows they override the
// Fibonacci priors per (tf, type); otherwise these priors are used.

import { windowFor } from './timingStats.js';

const B_RATIO = { lo: 0.382, hi: 1.618 };
const C_RATIO = { lo: 0.500, hi: 2.000 };
const FLOOR   = 0.30;   // minimum timing factor (never kills a hypothesis)
const NEUTRAL = 1.00;   // stub value before any timing info is available

// ── Helpers ───────────────────────────────────────────────────────────────────

// Linear soft factor: 1.0 inside [lo, hi], decays to FLOOR outside.
function softFactor(ratio, lo, hi) {
  if (ratio >= lo && ratio <= hi) return 1.0;
  if (ratio < lo) {
    // Too short: decay from 1.0 at lo to FLOOR at 0
    return lo > 0 ? Math.max(FLOOR, ratio / lo) : FLOOR;
  }
  // Too long: decay from 1.0 at hi to FLOOR over a second window of width hi
  return Math.max(FLOOR, 1.0 - (ratio - hi) / hi);
}

// Geometric mean of two factors (equal weighting without domination)
const gm = (a, b) => Math.sqrt(a * b);

// ── timingScore ───────────────────────────────────────────────────────────────
//
// Returns a soft confidence factor ∈ [FLOOR, 1.0] based on how well the
// observed leg durations (in candle bars) match the prior.
//
// currentBar: the candle index of "now" (only used for forming-stage hyps;
//             ignored for awaiting2° where C is already confirmed).
//
// Returns NEUTRAL (1.0) when index data is unavailable — callers should not
// penalise hypotheses that lack bar-index information.

// `win` (optional) supplies empirical [lo,hi] duration windows learned by the ①
// loop: { b:[lo,hi], c:[lo,hi] }. When absent, the Fibonacci priors are used —
// so this stays a soft, never-blocking factor with or without data.
export function timingScore(hyp, currentBar = null, win = null) {
  const { O, A, B, C } = hyp.anchor;

  if (!O || !A || O.index == null || A.index == null) return NEUTRAL;

  const legA = Math.abs(A.index - O.index);
  if (legA === 0) return NEUTRAL;

  const [bLo, bHi] = win?.b ?? [B_RATIO.lo, B_RATIO.hi];
  const [cLo, cHi] = win?.c ?? [C_RATIO.lo, C_RATIO.hi];
  const stage = hyp.stage;

  // ── formingB: B is still forming; measure elapsed time since A ────────────
  if (stage === 'formingB') {
    if (currentBar == null) return NEUTRAL;
    const elapsed = currentBar - A.index;
    if (elapsed < 0) return NEUTRAL;
    return softFactor(elapsed / legA, bLo, bHi);
  }

  // ── formingC: B confirmed; measure B duration + elapsed-since-B ──────────
  if (stage === 'formingC') {
    if (!B || B.index == null) return NEUTRAL;
    const bScore = softFactor(Math.abs(B.index - A.index) / legA, bLo, bHi);

    if (currentBar == null) return bScore;
    const elapsedC = currentBar - B.index;
    if (elapsedC < 0) return bScore;
    return gm(bScore, softFactor(elapsedC / legA, cLo, cHi));
  }

  // ── awaiting2°: all four confirmed; score both B and C durations ──────────
  if (stage === 'awaiting2°') {
    if (!B || !C || B.index == null || C.index == null) return NEUTRAL;
    const bScore = softFactor(Math.abs(B.index - A.index) / legA, bLo, bHi);
    const cScore = softFactor(Math.abs(C.index - B.index) / legA, cLo, cHi);
    return gm(bScore, cScore);
  }

  return NEUTRAL;  // formingA or unrecognised stage
}

// ── withTiming ────────────────────────────────────────────────────────────────
//
// Enriches each hypothesis with a `timing` component and adjusts
// confidence.value proportionally, replacing any previously applied timing.
//
// Safe to call multiple times (e.g. as bars elapse): each call replaces the
// previous timing factor without compounding.

export function withTiming(hyps, currentBar = null, opts = {}) {
  const { windows = null, tf = null } = opts;
  return hyps.map(h => {
    const win  = windows ? windowFor(windows, tf, h) : null;
    const ts   = timingScore(h, currentBar, win);
    const prev = h.confidence.components?.timing ?? NEUTRAL;
    const newV = Math.min(1.0, h.confidence.value * (ts / (prev || 1e-10)));
    return {
      ...h,
      confidence: {
        ...h.confidence,
        value:      newV,
        components: { ...h.confidence.components, timing: ts },
      },
    };
  });
}
