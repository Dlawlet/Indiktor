// Objective outcome resolver — the heart of the feedback loop.
//
// Given a frozen snapshot and the candles that printed AFTER it, decide for each
// scenario whether the projected target zone or the invalidation level was
// reached FIRST, walking candles in chronological order. Whichever the price
// touches first wins; if neither is touched by the end of the data, the scenario
// is still 'pending'. The decision is purely mechanical (no model judgement),
// so every auto-resolution is tagged `resolver:'auto'`.
//
// Pure module — no DOM, no network. See INTEGRATION.md for the ordering rules.

/**
 * @typedef {Object} Resolution
 * @property {string} scenarioId
 * @property {('target-hit'|'invalidated'|'pending')} outcome
 * @property {('auto')} resolver  Always 'auto' here; human overrides live in store.js records.
 * @property {number|null} price  The level that was hit (target-zone edge or invalidation), or null.
 * @property {number|null} time   Unix seconds of the candle that triggered it, or null.
 * @property {string|null} reason Short human-readable explanation.
 */

/**
 * @typedef {Object} ResolvedSnapshot
 * @property {string} snapshotId
 * @property {number} resolvedThrough  time of the last candle considered, or null.
 * @property {Resolution[]} resolutions
 */

/**
 * The target "zone" for a scenario is the span of its projected target prices.
 * We treat the NEAREST edge of that span (in the bias direction) as the trigger:
 * price entering the zone counts as the target being reached.
 *
 * Prefers the pre-computed `tpLo`/`tpHi` fields stored on the snapshot (richer
 * snapshots captured after the zone-aware update). Falls back to computing the
 * range from `scenario.targets` for legacy snapshots that lack these fields.
 *
 * @returns {{ near:number, far:number }|null}
 */
function targetZone(scenario) {
  // Prefer explicit tpLo/tpHi if present (new snapshot format).
  let lo = +scenario.tpLo;
  let hi = +scenario.tpHi;

  // Fall back to deriving from targets array (old snapshots).
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    // Also fall back to tp.price when targets array is absent.
    const tpPrice = scenario.tp?.price;
    const prices = (scenario.targets ?? [])
      .map((t) => +t.price)
      .filter((p) => Number.isFinite(p));
    if (prices.length) {
      lo = Math.min(...prices);
      hi = Math.max(...prices);
    } else if (Number.isFinite(+tpPrice)) {
      lo = hi = +tpPrice;
    } else {
      return null;
    }
  }

  // For an up move the zone is above price; the first edge reached is the low one.
  // For a down move the zone is below; the first edge reached is the high one.
  return scenario.bias === 'up' ? { near: lo, far: hi } : { near: hi, far: lo };
}

/**
 * Did candle `c` reach `level` in the direction implied by `bias`?
 * Up move: target above => high >= level; invalidation below => low <= level.
 * We test the relevant extreme using a direction sign and a comparator.
 * @param {Object} c candle {high, low}
 * @param {number} level
 * @param {('up'|'down')} biasOfLevel  the direction price must travel to hit it
 */
function reached(c, level, biasOfLevel) {
  if (!Number.isFinite(level)) return false;
  return biasOfLevel === 'up' ? c.high >= level : c.low <= level;
}

/**
 * Resolve a single scenario against later candles.
 * Walks candles oldest->newest; the FIRST candle that touches either the target
 * zone or the invalidation decides the outcome. If a single candle touches both
 * (a wide bar straddling both levels), we report it ambiguous but still pick by a
 * conservative rule: invalidation wins, because risk is realized before reward in
 * practice (and a human can override in the UI).
 *
 * @param {import('./snapshot.js').ScenarioSnapshot} scenario
 * @param {Array<{time:number,high:number,low:number}>} laterCandles ascending by time
 * @returns {Resolution}
 */
export function resolveScenario(scenario, laterCandles) {
  const zone = targetZone(scenario);
  const inval = +scenario.invalidation;
  const dir = scenario.bias; // direction price must go to HIT the target
  const invalDir = dir === 'up' ? 'down' : 'up'; // invalidation sits the other way

  const base = { scenarioId: scenario.id, resolver: 'auto', price: null, time: null };

  for (const c of laterCandles ?? []) {
    const hitTarget = zone ? reached(c, zone.near, dir) : false;
    const hitInval = reached(c, inval, invalDir);

    if (hitTarget && hitInval) {
      // Same bar straddles both — conservative: invalidation realized first.
      return { ...base, outcome: 'invalidated', price: inval, time: c.time,
        reason: 'single candle straddled both levels; invalidation prioritized' };
    }
    if (hitTarget) {
      return { ...base, outcome: 'target-hit', price: zone.near, time: c.time,
        reason: `price reached target zone edge ${zone.near}` };
    }
    if (hitInval) {
      return { ...base, outcome: 'invalidated', price: inval, time: c.time,
        reason: `price reached invalidation ${inval}` };
    }
  }

  return { ...base, outcome: 'pending', reason: 'neither target zone nor invalidation reached' };
}

/**
 * Resolve every scenario in a snapshot against later candles.
 * Candles at or before the snapshot timestamp are ignored (they predate the call).
 *
 * @param {import('./snapshot.js').Snapshot} snapshot
 * @param {Array<{time:number,high:number,low:number}>} laterCandles
 * @returns {ResolvedSnapshot}
 */
export function resolveSnapshot(snapshot, laterCandles) {
  const after = (laterCandles ?? [])
    .filter((c) => c && Number.isFinite(c.time) && c.time > snapshot.ts)
    .sort((a, b) => a.time - b.time);

  const resolutions = (snapshot.scenarios ?? []).map((s) => resolveScenario(s, after));
  const resolvedThrough = after.length ? after[after.length - 1].time : null;

  return { snapshotId: snapshot.id, resolvedThrough, resolutions };
}
