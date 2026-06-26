// Snapshot capture: freeze a ranked/enriched analysis into an immutable record so
// we can later check (objectively, from price history) which projected scenario
// actually played out. This builds the labeled dataset that scoring.js is honest
// about NOT having yet (model-derived confidence, not calibrated probability).
//
// Pure module — no DOM, no network, no clock reads beyond an injectable `now`.
// The captured record is the contract persisted by store.js and consumed by
// resolve.js + calibrate.js. See INTEGRATION.md for the JSON schema.

/**
 * @typedef {Object} ScenarioFeatures
 * @property {number} prior        Elliott template prior (0..1).
 * @property {number} guideline    Fibonacci/structure quality (0..1).
 * @property {string} pattern      'impulse' | 'correction' | 'continuation'.
 * @property {('up'|'down')} bias  Projected direction.
 * @property {number[]} targetRatios  Fib ratios of the target zone, ascending.
 * @property {number} probability  Model confidence at snapshot time (0..1).
 */

/**
 * @typedef {Object} ScenarioSnapshot
 * @property {string} id           Scenario template id (e.g. 'wave-3').
 * @property {string} name         Human-readable name.
 * @property {('up'|'down')} bias
 * @property {string} pattern
 * @property {number} invalidation Price that kills this count.
 * @property {Array<{label:string, ratio:number, price:number}>} targets
 *   Frozen copy of the projected target zone (prices captured AT snapshot time).
 * @property {ScenarioFeatures} features  Flat feature vector for calibration.
 */

/**
 * @typedef {Object} Snapshot
 * @property {string} id            Stable unique id (store key).
 * @property {number} ts            Unix seconds the snapshot was taken.
 * @property {string} asset         e.g. 'BTCUSDT'.
 * @property {string} timeframe     e.g. '1d'.
 * @property {number} priceAtAnalysis  Live price when the analysis was made.
 * @property {ScenarioSnapshot[]} scenarios
 */

/**
 * Generate a reasonably-unique id without external deps. crypto.randomUUID when
 * available (browser + modern Node), else a timestamp+random fallback.
 * @returns {string}
 */
export function makeId() {
  const g = globalThis;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
  return `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Pull a flat, calibration-ready feature vector out of one scenario. */
function featuresOf(s) {
  return Object.freeze({
    prior: num(s.prior),
    guideline: num(s.guideline),
    pattern: s.pattern,
    bias: s.bias,
    targetRatios: Object.freeze(
      (s.targets ?? [])
        .map((t) => num(t.ratio))
        .filter((r) => Number.isFinite(r))
        .sort((a, b) => a - b),
    ),
    invalidation: num(s.invalidation),
    probability: num(s.probability),
  });
}

/**
 * Deep-freeze one scenario into the persisted shape (prices captured as-is).
 * @param {Object} s  scenario
 * @param {{ isPrimary?: boolean }} [ctx]
 */
function snapshotScenario(s, ctx = {}) {
  const prices = (s.targets ?? [])
    .map((t) => num(t.price))
    .filter((p) => Number.isFinite(p));
  const tpLo = prices.length ? Math.min(...prices) : NaN;
  const tpHi = prices.length ? Math.max(...prices) : NaN;

  return Object.freeze({
    id: s.id,
    name: s.name,
    bias: s.bias,
    pattern: s.pattern,
    invalidation: num(s.invalidation),
    isPrimary: ctx.isPrimary === true,
    targets: Object.freeze(
      (s.targets ?? []).map((t) =>
        Object.freeze({ label: t.label, ratio: num(t.ratio), price: num(t.price) }),
      ),
    ),
    tpLo,
    tpHi,
    targetCount: (s.targets ?? []).length,
    features: featuresOf(s),
  });
}

/**
 * Capture an analysis as an immutable snapshot record.
 *
 * Accepts either a raw `analyze()` result ({scenarios}), the ranked array from
 * `rankScenarios()`, or the enriched array from `enrichScenarios()` — anything
 * exposing a `scenarios` array or being an array of scenarios works.
 *
 * @param {{scenarios:Array}|Array} analysis
 * @param {Object} meta
 * @param {string} meta.asset
 * @param {string} meta.timeframe
 * @param {number} meta.priceAtAnalysis
 * @param {() => number} [meta.now] Injectable clock (returns ms); default Date.now.
 * @param {string} [meta.id] Override id (else generated).
 * @returns {Snapshot} frozen record
 */
export function snapshotAnalysis(analysis, { asset, timeframe, priceAtAnalysis, now, id } = {}) {
  const list = Array.isArray(analysis) ? analysis : (analysis && analysis.scenarios) || [];
  const ms = typeof now === 'function' ? now() : Date.now();
  return Object.freeze({
    id: id ?? makeId(),
    ts: Math.floor(ms / 1000),
    asset,
    timeframe,
    priceAtAnalysis: num(priceAtAnalysis),
    scenarios: Object.freeze(list.map((s, i) => snapshotScenario(s, { isPrimary: i === 0 }))),
  });
}

function num(x) {
  const n = +x;
  return Number.isFinite(n) ? n : NaN;
}
