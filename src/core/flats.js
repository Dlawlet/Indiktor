// Flat pattern detector — pivot arithmetic first, channel shape second.
//
// Label comes from the 2×2 table on (rB ≷ 1, pC ≷ 0) — §A.5.
// Channel shape is a derived output used only for confidence/visualisation.
// Spec reference: wave_flat_detector_spec.md §A.1–A.9.

export const FLAT_COLORS = {
  regular:     '#f0a500',
  running:     '#00d4ff',
  expanding:   '#ff7744',
  contracting: '#5ccf7a',
};

export const FLAT_LABELS = {
  regular:     'Regular Flat',
  running:     'Running Flat',
  expanding:   'Expanding Flat',
  contracting: 'Contracting Flat',
};

// ── §A.4  Ratios ──────────────────────────────────────────────────────────────
// Pivot naming: O = aStart, A = aEnd, B = bEnd, C = cEnd.
//
//   legA       = A.price − O.price          (signed)
//   rB         = (A − B) / (A − O)          always ≥ 0;  > 1 iff B breaks O
//   pC         = (C − A) / (A − O)          > 0 iff C breaks A
//   lenC_lenA  = |C − B| / |A − O|          unsigned length ratio of C-leg
//
export function computeRatios(O, A, B, C) {
  const legA = A.price - O.price;
  if (legA === 0) return null;
  const rB        = (A.price - B.price) / legA;
  const pC        = (C.price - A.price) / legA;
  const lenC_lenA = Math.abs(C.price - B.price) / Math.abs(legA);
  return { legA, rB, pC, lenC_lenA };
}

// ── §A.5  Classification ──────────────────────────────────────────────────────
// Exactly two hard boundaries: rB = 1 and pC = 0. Nothing else changes the label.
//
//   rB ≤ 1, pC < 0  →  contracting
//   rB ≤ 1, pC > 0  →  regular
//   rB > 1, pC < 0  →  running
//   rB > 1, pC > 0  →  expanding
//
export function classifyFromRatios(rB, pC) {
  if (rB <= 1) return pC > 0 ? 'regular'   : 'contracting';
  return          pC > 0 ? 'expanding' : 'running';
}

// ── §A.6  Prototypicality bands + membership ──────────────────────────────────
export const BANDS = {
  //             rB [lo, ideal, hi]          pC [lo, ideal, hi]           lenC [lo, ideal, hi]
  regular:     { rB: [0.80, 0.95, 1.00],  pC: [ 0.00,  0.12,  0.30],  lenC: [0.85, 1.05, 1.30] },
  running:     { rB: [1.00, 1.15, 1.40],  pC: [-0.60, -0.25,  0.00],  lenC: [0.40, 0.70, 1.00] },
  expanding:   { rB: [1.00, 1.25, 1.50],  pC: [ 0.10,  0.35,  1.00],  lenC: [1.20, 1.60, 2.00] },
  contracting: { rB: [0.50, 0.70, 1.00],  pC: [-0.60, -0.20,  0.00],  lenC: [0.40, 0.65, 0.90] },
};

const F_FLOOR   = 0.15; // floor of membership function at band edge
const SOFT_TAIL = 0.25; // exponential decay constant outside band (ratio units)
const BAND_FLOOR = 0.20; // minimum band_fit to avoid non_flat gate (§A.9)

export function membership(x, lo, ideal, hi) {
  if (x === ideal) return 1.0;
  if (x >= lo && x <= hi) {
    return x < ideal
      ? F_FLOOR + (1 - F_FLOOR) * ((x - lo) / (ideal - lo))
      : 1       - (1 - F_FLOOR) * ((x - ideal) / (hi - ideal));
  }
  const d = x < lo ? lo - x : x - hi;
  return F_FLOOR * Math.exp(-d / SOFT_TAIL);
}

function geomean(a, b, c) {
  return Math.pow(Math.max(1e-9, a) * Math.max(1e-9, b) * Math.max(1e-9, c), 1 / 3);
}

export function bandFit(ratios, type) {
  const b = BANDS[type];
  if (!b) return 0;
  return geomean(
    membership(ratios.rB,        b.rB[0],   b.rB[1],   b.rB[2]),
    membership(ratios.pC,        b.pC[0],   b.pC[1],   b.pC[2]),
    membership(ratios.lenC_lenA, b.lenC[0], b.lenC[1], b.lenC[2]),
  );
}

// ── §A.9  non_flat gate ───────────────────────────────────────────────────────
// Returns true when the window can't fit any flat figure well enough.
function isNonFlat(ratios) {
  const best = Math.max(...Object.keys(BANDS).map((t) => bandFit(ratios, t)));
  return best < BAND_FLOOR;
}

// ── §A.7  Break test ──────────────────────────────────────────────────────────
// Parameters (tunable via opts.breakPolicy):
const DEFAULT_BREAK = {
  delta:    0.10, // ATR multiples: tolerance before "RESPECTED" ends
  bigMult:  2.00, // ATR multiples: wick alone counts as BROKEN
  tau:      0.50, // logistic width for scenario weight (ATR units)
};

// signed_beyond: positive = `val` has crossed `level` in `side` direction.
function signedBeyond(val, level, side) { return (val - level) * side; }

// §A.7 test_break
// side = +1: break = val goes above level; side = -1: break = val goes below.
function testBreak(wick, close, level, atrLocal, side, bp) {
  const safeAtr = (atrLocal > 0 && Number.isFinite(atrLocal))
    ? atrLocal
    : Math.abs(level) * 0.03 || 1; // 3% fallback when ATR absent

  const overrun   = signedBeyond(wick,  level, side);
  const overrunCl = signedBeyond(close, level, side);
  const m         = overrun / safeAtr;

  if (overrun   <= bp.delta   * safeAtr) return { result: 'RESPECTED', marginAtr: +m.toFixed(3) };
  if (overrunCl >  0 || m    >= bp.bigMult) return { result: 'BROKEN',    marginAtr: +m.toFixed(3) };
  return { result: 'AMBIGUOUS', marginAtr: +m.toFixed(3) };
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// Logistic weight for "BROKEN" interpretation when test is AMBIGUOUS.
function ambigWeights(marginAtr, tau) {
  const wBroken = sigmoid(marginAtr / tau);
  return { wBroken, wRespected: 1 - wBroken };
}

// ── §A.8  Confidence components ───────────────────────────────────────────────
const CONF_WEIGHTS = {
  band_fit:          0.45,
  break_clarity:     0.25,
  channel_residual:  0.15,
  scale_stability:   0.10,
  nesting_coherence: 0.05,
};

// Penalty per AMBIGUOUS break; two ambiguous = ×0.78².
function breakClarity(bTest, cTest) {
  let s = 1.0;
  if (bTest.result === 'AMBIGUOUS') s *= 0.78;
  if (cTest.result === 'AMBIGUOUS') s *= 0.78;
  return s;
}

// Fraction of candle closes in [tO, tC] that lie inside the O→B / A→C channel.
// Returns 0.6 (neutral) when candles are unavailable.
function channelResidual(O, A, B, C, candles) {
  if (!candles || !candles.length) return 0.6;

  // Rail functions: O→B and A→C, linearly interpolated (and extrapolated).
  const mkRail = (p1, p2) => {
    const dt = p2.time - p1.time;
    return dt === 0
      ? () => p1.price
      : (t) => p1.price + (p2.price - p1.price) * (t - p1.time) / dt;
  };

  // For a bull flat: O and B are the lower pivots; A and C are the upper pivots.
  const bull = O.price < A.price;
  const lowerRail = bull ? mkRail(O, B) : mkRail(A, C);
  const upperRail = bull ? mkRail(A, C) : mkRail(O, B);

  const tStart = O.time;
  const tEnd   = C.time;

  let inside = 0, total = 0;
  for (const c of candles) {
    if (c.time < tStart || c.time > tEnd) continue;
    const lo = lowerRail(c.time);
    const hi = upperRail(c.time);
    total++;
    if (c.close >= lo && c.close <= hi) inside++;
  }
  return total >= 2 ? inside / total : 0.6;
}

function aggregateConfidence(components) {
  let score = 0;
  let totalW = 0;
  for (const [k, w] of Object.entries(CONF_WEIGHTS)) {
    score  += w * (components[k] ?? 0.6);
    totalW += w;
  }
  return Math.max(0, Math.min(1, totalW > 0 ? score / totalW : 0));
}

// ── Candidate builder ─────────────────────────────────────────────────────────

function buildCand(type, ratios, O, A, B, C, bTest, cTest, scenarioW, candles) {
  const bf = bandFit(ratios, type);
  if (bf < F_FLOOR) return null; // this specific type doesn't fit

  const components = {
    band_fit:          bf,
    break_clarity:     breakClarity(bTest, cTest),
    channel_residual:  channelResidual(O, A, B, C, candles),
    scale_stability:   0.60, // placeholder — needs candle re-runs (§A.8)
    nesting_coherence: 0.60, // placeholder — needs multi-TF context (§A.10)
  };

  const confidence = aggregateConfidence(components) * Math.max(0, Math.min(1, scenarioW));

  return {
    type,
    label:  FLAT_LABELS[type],
    bias:   ratios.legA > 0 ? 'bull' : 'bear',
    aStart: O, aEnd: A, bEnd: B, cEnd: C,
    ratios: {
      rB:        +ratios.rB.toFixed(3),
      pC:        +ratios.pC.toFixed(3),
      lenC_lenA: +ratios.lenC_lenA.toFixed(3),
    },
    // Legacy UI aliases expected by app.js / chart.js
    bRet: +ratios.rB.toFixed(3),        // "B/A" column = rB
    cRet: +ratios.lenC_lenA.toFixed(3), // "C/A" column = lenC_lenA
    breakTests:            { B_vs_O: bTest, C_vs_A: cTest },
    confidence:            +confidence.toFixed(3),
    confidenceComponents:  components,
    scenarioWeight:        +scenarioW.toFixed(3),
  };
}

// ── §A.7  Scenario resolution (dual-scenario forking) ────────────────────────
//
// Table from spec:
//   B ambig, pC > 0  →  regular ↔ expanding
//   B ambig, pC < 0  →  contracting ↔ running
//   C ambig, rB > 1  →  running ↔ expanding
//   C ambig, rB ≤ 1  →  contracting ↔ regular
//   B & C ambig      →  all four (rare)
//
function resolveScenarios(ratios, O, A, B, C, bTest, cTest, bp, candles) {
  const { rB, pC } = ratios;
  const bAmbig = bTest.result === 'AMBIGUOUS';
  const cAmbig = cTest.result === 'AMBIGUOUS';

  if (!bAmbig && !cAmbig) {
    const type = classifyFromRatios(rB, pC);
    return [buildCand(type, ratios, O, A, B, C, bTest, cTest, 1.0, candles)].filter(Boolean);
  }

  if (bAmbig && cAmbig) {
    const { wBroken: wBB, wRespected: wBR } = ambigWeights(bTest.marginAtr, bp.tau);
    const { wBroken: wCB, wRespected: wCR } = ambigWeights(cTest.marginAtr, bp.tau);
    return [
      ['contracting', wBR * wCR],
      ['regular',     wBR * wCB],
      ['running',     wBB * wCR],
      ['expanding',   wBB * wCB],
    ].map(([t, w]) => buildCand(t, ratios, O, A, B, C, bTest, cTest, w, candles))
     .filter(Boolean);
  }

  if (bAmbig) {
    const { wBroken, wRespected } = ambigWeights(bTest.marginAtr, bp.tau);
    if (pC > 0) {
      return [
        buildCand('regular',   ratios, O, A, B, C, bTest, cTest, wRespected, candles),
        buildCand('expanding', ratios, O, A, B, C, bTest, cTest, wBroken,    candles),
      ].filter(Boolean);
    }
    return [
      buildCand('contracting', ratios, O, A, B, C, bTest, cTest, wRespected, candles),
      buildCand('running',     ratios, O, A, B, C, bTest, cTest, wBroken,    candles),
    ].filter(Boolean);
  }

  // cAmbig only
  const { wBroken, wRespected } = ambigWeights(cTest.marginAtr, bp.tau);
  if (rB > 1) {
    return [
      buildCand('running',   ratios, O, A, B, C, bTest, cTest, wRespected, candles),
      buildCand('expanding', ratios, O, A, B, C, bTest, cTest, wBroken,    candles),
    ].filter(Boolean);
  }
  return [
    buildCand('contracting', ratios, O, A, B, C, bTest, cTest, wRespected, candles),
    buildCand('regular',     ratios, O, A, B, C, bTest, cTest, wBroken,    candles),
  ].filter(Boolean);
}

// ── Hard pre-filters (applied before classification) ─────────────────────────

// 1. Containment: every candle wick between O and C must stay inside [floor, roof].
//    The 4 pivot prices are the wick extremes; anything beyond them means a
//    larger move occurred inside the flat that would invalidate the structure.
export function candlesContained(O, A, B, C, candles) {
  if (!candles || !candles.length) return true;

  const floor = Math.min(O.price, A.price, B.price, C.price);
  const roof  = Math.max(O.price, A.price, B.price, C.price);
  const tol   = (roof - floor) * 1e-6; // float-safety only — no real slack

  // Pivot.index is the candle-array position written by zigzag(); fall back to
  // a linear scan only when the caller supplies hand-crafted pivots (tests).
  const iStart = O.index != null ? O.index : candles.findIndex(c => c.time >= O.time);
  const iEnd   = C.index != null ? C.index : candles.findIndex(c => c.time >= C.time);
  if (iStart < 0 || iEnd < 0 || iEnd < iStart) return true;

  for (let i = iStart; i <= iEnd; i++) {
    const c = candles[i];
    if (c.high > roof + tol || c.low < floor - tol) return false;
  }
  return true;
}

// 2. Trend context: a flat is corrective (counter-trend).
//    legA > 0 (bull flat, bearish main trend):
//      • 1° (pivot before O) must be ABOVE A — confirming the prior impulse exceeded
//        the correction's peak, giving a valid invalidation level above A
//      • 2° (pivot after C) must be BELOW B — confirming bearish continuation clears
//        below the flat's internal low, giving a valid TP target below B
//    legA < 0 (bear flat, bullish main trend): mirror image.
//    When a context pivot is absent (edge of data) that side is skipped.
export function trendContextOk(pivots, startIdx, ci, legA, A, B) {
  if (startIdx > 0) {
    const preO = pivots[startIdx - 1];
    // 1° must be beyond A in the main-trend direction:
    //   bull flat (legA>0): preO > A  |  bear flat (legA<0): preO < A
    if ((preO.price - A.price) * legA <= 0) return false;
  }

  if (ci + 1 < pivots.length) {
    const postC = pivots[ci + 1];
    // 2° must clear beyond B in the continuation direction:
    //   bull flat (legA>0): postC < B  |  bear flat (legA<0): postC > B
    if ((B.price - postC.price) * legA <= 0) return false;
  }

  return true;
}

// ── Core window classifier ────────────────────────────────────────────────────

function classifyWindow(O, A, B, C, bp, candles) {
  const ratios = computeRatios(O, A, B, C);
  if (!ratios) return [];

  // §A.9 non_flat gate — skip windows that can't fit any figure
  if (isNonFlat(ratios)) return [];

  // §A.7 break tests
  const sideB  = -Math.sign(ratios.legA); // B breaks O: opposite to legA
  const sideC  =  Math.sign(ratios.legA); // C breaks A: same as legA
  const atrB   = (B.atr > 0 && Number.isFinite(B.atr)) ? B.atr : Math.abs(ratios.legA) * 0.03;
  const atrC   = (C.atr > 0 && Number.isFinite(C.atr)) ? C.atr : Math.abs(ratios.legA) * 0.03;
  const closeB = B.close ?? B.price;
  const closeC = C.close ?? C.price;

  const bTest = testBreak(B.price, closeB, O.price, atrB, sideB, bp);
  const cTest = testBreak(C.price, closeC, A.price, atrC, sideC, bp);

  return resolveScenarios(ratios, O, A, B, C, bTest, cTest, bp, candles);
}

// ── Best-flat search for a given O-start ─────────────────────────────────────

function bestFlatFrom(pivots, startIdx, minConf, maxSpan, altGap, bp, candles) {
  let bestPats = [];
  let bestConf = minConf;
  let bestCIdx = -1;
  const n = pivots.length;
  const O = pivots[startIdx];

  for (let aOff = 1; aOff <= maxSpan; aOff++) {
    const ai = startIdx + aOff;
    if (ai >= n) break;
    const A = pivots[ai];
    const legA = A.price - O.price;
    if (legA === 0) continue;

    for (let bOff = 1; bOff <= maxSpan; bOff++) {
      const bi = ai + bOff;
      if (bi >= n) break;
      const B = pivots[bi];
      if (Math.sign(B.price - A.price) !== -Math.sign(legA)) continue;

      // Quick pre-filter on rB before building C candidates
      const rB = (A.price - B.price) / legA;
      if (rB < 0.18 || rB > 3.5) continue;

      for (let cOff = 1; cOff <= maxSpan; cOff++) {
        const ci = bi + cOff;
        if (ci >= n) break;
        const C = pivots[ci];
        if (Math.sign(C.price - B.price) !== Math.sign(legA)) continue;

        const lenC = Math.abs(C.price - B.price) / Math.abs(legA);
        if (lenC < 0.10) continue;

        // Hard filter 1 — all candles inside the flat must stay within [floor, roof]
        if (!candlesContained(O, A, B, C, candles)) continue;

        // Hard filter 2 — the flat must be corrective: trend before O and after C
        //                  must run opposite to legA (main trend continuity)
        if (!trendContextOk(pivots, startIdx, ci, legA, A, B)) continue;

        const cands = classifyWindow(O, A, B, C, bp, candles);
        if (!cands.length) continue;

        cands.sort((x, y) => y.confidence - x.confidence);
        const top = cands[0].confidence;
        if (top > bestConf) {
          bestConf = top;
          bestPats = cands.filter((s) => top - s.confidence <= altGap && s.confidence >= minConf);
          if (!bestPats.length) bestPats = [cands[0]];
          bestCIdx = ci;
        }
      }
    }
  }
  return { pats: bestPats, cIdx: bestCIdx };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Greedy left-to-right historical scan.
 *
 * @param {Array}  pivots        zigzag output (confirmed pivots only)
 * @param {object} opts
 * @param {number} opts.minConfidence   default 0.55
 * @param {number} opts.maxLegSpan      pivot-gap span per leg, default 3
 * @param {number} opts.altGap          keep alt scenarios within this gap, default 0.08
 * @param {Array}  opts.candles         raw OHLCV — enables channel_residual scoring
 * @param {object} opts.breakPolicy     override delta/bigMult/tau
 */
export function detectFlatPatterns(pivots, opts = {}) {
  const {
    minConfidence = 0.55,
    maxLegSpan    = 3,
    altGap        = 0.08,
    candles       = null,
    breakPolicy   = {},
  } = opts;

  const bp = { ...DEFAULT_BREAK, ...breakPolicy };
  const confirmed = pivots.filter((p) => !p.tentative);
  const n = confirmed.length;
  const out = [];
  let i = 0;

  while (i < n - 3) {
    const { pats, cIdx } = bestFlatFrom(confirmed, i, minConfidence, maxLegSpan, altGap, bp, candles);
    if (pats.length) {
      out.push(...pats);
      i = cIdx;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Check if the last pivots form an in-progress flat (AB confirmed, C forming).
 * Returns a live-flat descriptor or null.
 */
export function detectLiveFlat(pivots, opts = {}) {
  const { minConfidence = 0.40, breakPolicy = {} } = opts;
  const bp = { ...DEFAULT_BREAK, ...breakPolicy };

  if (pivots.length < 3) return null;

  for (let back = 3; back <= Math.min(5, pivots.length); back++) {
    const slice = pivots.slice(-back);
    const O = slice[0];
    const A = slice[slice.length - 2];
    const B = slice[slice.length - 1];

    const legA = A.price - O.price;
    if (legA === 0) continue;
    if (Math.sign(B.price - A.price) !== -Math.sign(legA)) continue;

    const rB = (A.price - B.price) / legA;
    if (rB < 0.18 || rB > 3.5) continue;

    const sideB  = -Math.sign(legA);
    const atrB   = (B.atr > 0 && Number.isFinite(B.atr)) ? B.atr : Math.abs(legA) * 0.03;
    const closeB = B.close ?? B.price;
    const bTest  = testBreak(B.price, closeB, O.price, atrB, sideB, bp);

    let possibleTypes;
    if (bTest.result === 'BROKEN')    possibleTypes = ['running', 'expanding'];
    else if (bTest.result === 'RESPECTED') possibleTypes = rB >= 0.65 ? ['regular', 'contracting'] : ['contracting', 'regular'];
    else possibleTypes = ['regular', 'running', 'contracting', 'expanding'];

    // rough AB confidence (no C yet)
    const abBf = Math.max(...possibleTypes.map((t) => {
      const mockRatios = { rB, pC: 0, lenC_lenA: 1 };
      return bandFit(mockRatios, t);
    }));
    const abConf = abBf * (bTest.result === 'AMBIGUOUS' ? 0.75 : 1.0);
    if (abConf < minConfidence) continue;

    return {
      possibleTypes,
      bias:    legA > 0 ? 'bull' : 'bear',
      aStart:  O,
      aEnd:    A,
      bEnd:    B,
      bRet:    +rB.toFixed(3),
      abConf:  +abConf.toFixed(2),
      bBreakState: bTest.result,
      cTargets: _cTargets(A, legA, possibleTypes),
      aDir: Math.sign(legA),
    };
  }
  return null;
}

// C target zone given possible types (using spec band pC ranges)
function _cTargets(A, legA, types) {
  const lvl = (pC) => A.price + pC * legA;
  let lo = Infinity, hi = -Infinity;
  const pCRanges = {
    regular:     [-0.00, 0.30],
    running:     [-0.60, 0.00],
    expanding:   [ 0.10, 1.00],
    contracting: [-0.60, 0.00],
  };
  for (const t of types) {
    const [tLo, tHi] = pCRanges[t];
    const p1 = lvl(tLo), p2 = lvl(tHi);
    lo = Math.min(lo, p1, p2);
    hi = Math.max(hi, p1, p2);
  }
  return lo === Infinity ? null : { min: lo, max: hi };
}
