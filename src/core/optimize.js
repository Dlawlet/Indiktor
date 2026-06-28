// ① optimize — client-side parameter sweep (the active half of the loop).
//
// Passive snapshots only ever carry ONE param config, so they can't compare
// configs. This sweep does what tools/backtest.js does, but over the shipped
// flat engine and per-segment: for each param combo it slides an "as-of" cursor
// across history, runs the real prediction pipeline, and resolves each forecast
// first-touch (TP vs invalidation) against the candles that actually followed.
// The resulting observations feed estimate.js (shrinkage) → best param/segment.
//
// Pure (no DOM, no network). Heavy → run inside a Web Worker (see optimize.worker.js).

import { zigzag } from './zigzag.js';
import { enumerateHypotheses, rankAndBeam } from './predict.js';
import { withTiming } from './timing.js';
import { classifyHypothesisPath } from './snapshot.js';
import { buildParams, hashParams, segmentKey } from './params.js';
import { estimateFromObservations, bestParamPerSegment } from './estimate.js';

const MIN_PIVOTS  = 4;   // need O,A,B,(C) before a hypothesis can form
const MIN_FUTURE  = 5;   // require some lookahead, else everything is "pending"

// Cartesian product of a grid spec, e.g. { k:[2,3], minConf:[0.5,0.6] } → 4 combos.
export function expandGrid(spec) {
  let combos = [{}];
  for (const key of Object.keys(spec)) {
    const vals = spec[key];
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [key]: v });
    combos = next;
  }
  return combos;
}

// Sweep ONE series under a set of param combos → observations[].
export function sweepSeries(candles, tf, combos, opts = {}) {
  const { byType = false, predFloor: floorDefault = 0.15, beam: beamDefault = 4 } = opts;
  if (!candles?.length) return [];
  const obs = [];

  for (const combo of combos) {
    const k         = combo.k ?? 3;
    const minFloor  = combo.predFloor ?? floorDefault;
    const beam      = combo.beam ?? beamDefault;
    const paramHash = hashParams(buildParams(combo));

    const pivots = zigzag(candles, { atrMult: k, atrPeriod: 14 }).filter(p => !p.tentative);
    if (pivots.length < MIN_PIVOTS) continue;

    for (let cut = MIN_PIVOTS; cut <= pivots.length; cut++) {
      const upto    = pivots.slice(0, cut);
      const asOfBar = upto[upto.length - 1].index;
      if (asOfBar == null) continue;
      const future = candles.slice(asOfBar + 1);
      if (future.length < MIN_FUTURE) break; // too close to the right edge

      const livePrice = candles[asOfBar].close;
      let hyps = enumerateHypotheses(upto, livePrice);
      hyps = withTiming(hyps, asOfBar);
      hyps = rankAndBeam(hyps, beam).filter(h => h.confidence.value >= minFloor);

      for (const h of hyps) {
        const outcome = classifyHypothesisPath(h, future);
        const y = outcome === 'hit' ? 1 : outcome === 'miss' ? 0 : null; // exclude pending
        if (y == null) continue;
        const type = byType ? (h.typeBranch?.[0] ?? null) : null;
        obs.push({ seg: segmentKey(tf, type), paramHash, conf: h.confidence.value, y });
      }
    }
  }
  return obs;
}

// Full optimisation across several series.
//   series:   [{ candles, tf }]
//   gridSpec: { k:[...], minConf:[...], predFloor:[...] , ... }
// Returns { estimate, best, proposals, nObs, combos }.
export function optimize(series, gridSpec, opts = {}) {
  const combos = expandGrid(gridSpec);
  let obs = [];
  for (const s of series ?? []) obs = obs.concat(sweepSeries(s.candles, s.tf, combos, opts));

  const estimate = estimateFromObservations(obs, opts);
  const best     = bestParamPerSegment(estimate, { minN: opts.minN ?? 20 });

  // Map winning paramHash → the actual param values.
  const byHash = {};
  for (const c of combos) byHash[hashParams(buildParams(c))] = buildParams(c);

  const proposals = {};
  for (const [seg, b] of Object.entries(best)) {
    if (b) proposals[seg] = { ...b, params: byHash[b.paramHash] ?? null };
  }
  return { estimate, best, proposals, nObs: obs.length, combos: combos.length };
}
