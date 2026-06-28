// ① estimate — partial pooling / shrinkage.
//
// We want a per-segment (TF, optionally ×type) and per-(segment×param) hit-rate
// estimate that does NOT overfit thin slices. Instead of a binary "global vs
// per-segment" choice, every estimate is shrunk toward its parent pool, weighted
// by sample count (empirical-Bayes style):
//
//   rate = (hits + k·prior) / (n + k)
//
//   global              : prior = 0.5 (uninformative)
//   segment             : prior = global rate
//   segment × paramHash : prior = that segment's shrunk rate
//
// k is a pseudo-count: a slice needs ~k samples before it half-trusts its own
// raw rate. So a 2-sample param config barely moves off the segment mean, while
// a 200-sample one is essentially its own rate. Pure module.

import { segmentKey } from './params.js';

export const SHRINK_K = 10;

const labelOf = (o) => (o === 'hit' ? 1 : (o === 'miss' || o === 'expired') ? 0 : null);

// Flatten resolved per-hypothesis outcomes into learning observations.
// byType=true segments by (tf, primary type); else by tf alone.
export function observations(snapshots, { byType = false } = {}) {
  const out = [];
  for (const s of snapshots ?? []) {
    const tf = s.tf ?? s.params?.tf ?? '?';
    const paramHash = s.paramHash ?? '?';
    for (const h of s.hypotheses ?? []) {
      const y = labelOf(h.outcome);
      if (y == null) continue;
      const type = byType ? (h.typeBranch?.[0] ?? null) : null;
      out.push({ seg: segmentKey(tf, type), paramHash, conf: h.confidence?.value, y });
    }
  }
  return out;
}

function shrink(hits, n, prior, k) {
  return (hits + k * prior) / (n + k);
}

// Core estimator over pre-flattened observations.
export function estimateFromObservations(obs, { k = SHRINK_K } = {}) {
  const list = (obs ?? []).filter(o => o && (o.y === 0 || o.y === 1));
  const N = list.length;
  const globalRate = N ? list.reduce((s, o) => s + o.y, 0) / N : null;

  const segMap = {};
  for (const o of list) {
    const seg = (segMap[o.seg] ??= { n: 0, hits: 0, byParam: {} });
    seg.n++; seg.hits += o.y;
    const p = (seg.byParam[o.paramHash] ??= { n: 0, hits: 0 });
    p.n++; p.hits += o.y;
  }

  const gPrior = globalRate ?? 0.5;
  const segments = {};
  for (const [seg, d] of Object.entries(segMap)) {
    const rate = shrink(d.hits, d.n, gPrior, k);  // shrink segment → global
    const byParam = {};
    for (const [hash, p] of Object.entries(d.byParam)) {
      byParam[hash] = {
        n: p.n,
        raw:  p.n ? p.hits / p.n : null,
        rate: shrink(p.hits, p.n, rate, k),        // shrink param → segment
      };
    }
    segments[seg] = { n: d.n, raw: d.n ? d.hits / d.n : null, rate, byParam };
  }
  return { global: { n: N, rate: globalRate }, segments, k };
}

export function estimateRates(snapshots, opts = {}) {
  return estimateFromObservations(observations(snapshots, opts), opts);
}

// Pick the best paramHash per segment by shrunk rate, requiring at least
// `minN` raw samples so a 1-sample fluke can't win. Returns
// { [seg]: { paramHash, rate, raw, n } | null }.
export function bestParamPerSegment(estimate, { minN = 1 } = {}) {
  const out = {};
  for (const [seg, d] of Object.entries(estimate.segments ?? {})) {
    let best = null;
    for (const [paramHash, p] of Object.entries(d.byParam)) {
      if (p.n < minN) continue;
      if (!best || p.rate > best.rate) best = { paramHash, rate: p.rate, raw: p.raw, n: p.n };
    }
    out[seg] = best;
  }
  return out;
}
