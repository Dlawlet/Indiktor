// Calibration SCAFFOLD — NOT predictive ML.
//
// This is the honest follow-through on README's "probabilities are model-derived
// confidence, not calibrated outcomes". Once enough snapshots have a realized
// outcome, we can ask: "when the model said 60%, did ~60% actually hit?" and learn
// a simple monotonic mapping from raw model confidence -> empirical hit rate.
//
// Deliberately NOT a neural net / classifier over the full feature vector. It is
// a one-dimensional, interpretable reliability mapping (logistic on raw, with an
// isotonic-style binning helper) plus a hard safety rail: below a minimum sample
// count we return the raw probability UNCHANGED. A small dataset cannot calibrate
// anything, and pretending otherwise would be worse than the status quo.
//
// Pure module — no DOM, no network, no persistence.

/** Below this many resolved examples, calibration is a no-op (returns raw). */
export const MIN_SAMPLES = 30;

/**
 * Flatten stored records into a learning dataset of (features -> binary outcome).
 * Only resolved scenarios count: 'target-hit' => 1, 'invalidated' => 0. 'pending'
 * scenarios are skipped (no ground truth yet).
 *
 * @param {import('./store.js').StoredRecord[]} records
 * @returns {Array<{features: import('./snapshot.js').ScenarioFeatures, outcome: 0|1, resolver:('auto'|'human'), scenarioId:string, snapshotId:string}>}
 */
export function exportDataset(records) {
  const out = [];
  for (const rec of records ?? []) {
    const snap = rec.snapshot;
    if (!snap || !Array.isArray(snap.scenarios)) continue;
    const outcomes = rec.outcomes ?? {};
    for (const s of snap.scenarios) {
      const o = outcomes[s.id];
      if (!o) continue;
      const label = labelOf(o.outcome);
      if (label == null) continue; // pending / unknown -> no ground truth
      out.push({
        snapshotId: snap.id,
        scenarioId: s.id,
        features: s.features,
        outcome: label,
        resolver: o.resolver ?? 'auto',
      });
    }
  }
  return out;
}

/**
 * Fit a 1-D logistic reliability curve mapping raw model probability -> empirical
 * hit probability, via gradient descent on log loss. Interpretable: just a slope
 * and intercept on the raw probability. Returns a model object usable by
 * `applyCalibration`.
 *
 * @param {Array<{features:{probability:number}, outcome:0|1}>} dataset from exportDataset
 * @param {Object} [opts]
 * @param {number} [opts.iterations=500]
 * @param {number} [opts.lr=0.1] learning rate
 * @returns {{type:'logistic', a:number, b:number, n:number, fitted:boolean, reliability:Array}}
 */
export function calibrate(dataset, opts = {}) {
  const data = (dataset ?? [])
    .map((d) => ({ x: clamp01(d.features?.probability ?? d.x), y: d.outcome }))
    .filter((d) => Number.isFinite(d.x) && (d.y === 0 || d.y === 1));

  const n = data.length;
  // Identity model (a=1, b=0) means applyCalibration returns raw unchanged.
  const base = { type: 'logistic', a: 1, b: 0, n, fitted: false, reliability: reliabilityBins(data) };
  if (n < MIN_SAMPLES) return base;

  const iterations = opts.iterations ?? 500;
  const lr = opts.lr ?? 0.1;
  // logit(p_cal) = a * logit(x) + b ; fit a,b by gradient descent on log loss.
  let a = 1, b = 0;
  for (let it = 0; it < iterations; it++) {
    let ga = 0, gb = 0;
    for (const { x, y } of data) {
      const z = a * logit(x) + b;
      const p = sigmoid(z);
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
 * Apply a calibration model to a raw probability.
 * Safety rail: if the model was not fitted (too few samples), return `raw`
 * unchanged. Otherwise map through the fitted logistic.
 *
 * @param {{a:number,b:number,fitted:boolean}} model from calibrate()
 * @param {number} raw model confidence in [0,1]
 * @returns {number} calibrated probability in [0,1]
 */
export function applyCalibration(model, raw) {
  const x = clamp01(raw);
  if (!model || !model.fitted) return x; // below MIN_SAMPLES => raw, untouched
  return clamp01(sigmoid(model.a * logit(x) + model.b));
}

/**
 * Isotonic-style reliability table: bucket raw probabilities and report the
 * empirical hit rate per bucket. Purely diagnostic (for the review UI / docs);
 * shows monotonicity of the underlying data without imposing a parametric form.
 * @param {Array<{x:number,y:number}>} data
 * @param {number} [bins=10]
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
  if (outcome === 'target-hit') return 1;
  if (outcome === 'invalidated') return 0;
  return null; // pending / unknown
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
