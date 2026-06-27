// Confidence calibration for the predictive flat engine.
//
// The engine emits a model-derived `confidence.value` per hypothesis. That is
// NOT a calibrated probability — when the model says 0.60, history may show that
// such hypotheses hit only ~45% of the time. Once enough hypotheses have a
// resolved outcome (hit / miss / expired), we learn a 1-D monotonic mapping from
// raw confidence → empirical hit rate.
//
// Deliberately interpretable: a logistic on the raw confidence (a slope + an
// intercept), plus an isotonic-style reliability table for diagnostics. Hard
// safety rail: below MIN_SAMPLES resolved examples, calibration is a no-op and
// returns the raw confidence unchanged — a tiny dataset cannot calibrate
// anything, and pretending otherwise is worse than doing nothing.
//
// Pure module — no DOM, no network, no persistence. Reads the localStorage
// snapshot shape produced by core/snapshot.js (snapshots whose hypotheses carry
// a per-hypothesis `outcome` set by evaluateSnapshotPath).

/** Below this many resolved hypotheses, calibration is a no-op (returns raw). */
export const MIN_SAMPLES = 30;

/**
 * Flatten snapshots into a learning dataset of (confidence → binary outcome).
 * Only resolved hypotheses count: 'hit' → 1, 'miss'/'expired' → 0.
 * 'pending' / null are skipped (no ground truth yet).
 *
 * @param {Array} snapshots  localStorage snapshot records
 * @returns {Array<{x:number, y:0|1, stage:string, bias:string}>}
 */
export function exportDataset(snapshots) {
  const out = [];
  for (const s of snapshots ?? []) {
    for (const h of s.hypotheses ?? []) {
      const y = labelOf(h.outcome);
      if (y == null) continue;
      const x = h.confidence?.value;
      if (!Number.isFinite(x)) continue;
      out.push({ x, y, stage: h.stage, bias: h.bias });
    }
  }
  return out;
}

/**
 * Fit a 1-D logistic reliability curve mapping raw confidence → empirical hit
 * probability, by gradient descent on log loss. Returns a model usable by
 * applyCalibration. Below MIN_SAMPLES it returns an identity model (a=1, b=0,
 * fitted:false) so applyCalibration passes the raw value through untouched.
 *
 * @param {Array<{x:number,y:0|1}>} dataset  from exportDataset
 * @param {{iterations?:number, lr?:number}} [opts]
 */
export function calibrate(dataset, opts = {}) {
  const data = (dataset ?? [])
    .map(d => ({ x: clamp01(d.x), y: d.y }))
    .filter(d => Number.isFinite(d.x) && (d.y === 0 || d.y === 1));

  const n = data.length;
  const base = { type: 'logistic', a: 1, b: 0, n, fitted: false, reliability: reliabilityBins(data) };
  if (n < MIN_SAMPLES) return base;

  const iterations = opts.iterations ?? 500;
  const lr = opts.lr ?? 0.1;
  let a = 1, b = 0; // logit(p_cal) = a·logit(x) + b
  for (let it = 0; it < iterations; it++) {
    let ga = 0, gb = 0;
    for (const { x, y } of data) {
      const p = sigmoid(a * logit(x) + b);
      const err = p - y;
      ga += err * logit(x);
      gb += err;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
  }
  return { type: 'logistic', a, b, n, fitted: true, reliability: reliabilityBins(data) };
}

/**
 * Apply a calibration model to a raw confidence. Returns `raw` unchanged when
 * the model was not fitted (too few samples).
 */
export function applyCalibration(model, raw) {
  const x = clamp01(raw);
  if (!model || !model.fitted) return x;
  return clamp01(sigmoid(model.a * logit(x) + model.b));
}

/**
 * Isotonic-style reliability table: bucket raw confidences and report the
 * empirical hit rate per bucket. Purely diagnostic (drives the snapshots UI).
 */
export function reliabilityBins(data, bins = 10) {
  const acc = Array.from({ length: bins }, () => ({ sum: 0, n: 0 }));
  for (const { x, y } of data ?? []) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(clamp01(x) * bins)));
    acc[i].sum += y; acc[i].n += 1;
  }
  return acc.map((b, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: b.n,
    hitRate: b.n ? b.sum / b.n : null,
  }));
}

function labelOf(outcome) {
  if (outcome === 'hit') return 1;
  if (outcome === 'miss' || outcome === 'expired') return 0;
  return null; // pending / null → no ground truth
}

const EPS = 1e-6;
function clamp01(x) {
  const n = +x;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function logit(p) {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
}
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}
