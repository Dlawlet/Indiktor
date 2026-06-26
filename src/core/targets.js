// Objective target estimation: cluster candidate price levels into confluence
// zones, then derive a primary take-profit, a direction-switch level, and a
// risk/reward ratio for each scenario.
//
// "Confluence" = where several independent methods (Fibonacci targets, prior
// swing structure, other timeframes) point at the same price. The densest
// cluster is the highest-quality target.

/**
 * Greedily cluster price levels that sit within `tol` (fractional) of each other.
 * @param {Array<{price:number, weight?:number, source?:string}>} levels
 * @returns {Array<{price:number, weight:number, members:Array, lo:number, hi:number}>}
 *   weighted-centroid clusters, sorted by weight desc then tightness.
 */
export function confluence(levels, tol = 0.012) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = null;
  for (const lv of sorted) {
    const w = lv.weight ?? 1;
    if (cur && Math.abs(lv.price - cur.last) <= tol * lv.price) {
      cur.sum += lv.price * w; cur.weight += w; cur.members.push(lv);
      cur.last = lv.price; cur.hi = lv.price;
    } else {
      if (cur) clusters.push(finalize(cur));
      cur = { sum: lv.price * w, weight: w, members: [lv], last: lv.price, lo: lv.price, hi: lv.price };
    }
  }
  if (cur) clusters.push(finalize(cur));
  return clusters.sort((a, b) => b.weight - a.weight || (a.hi - a.lo) - (b.hi - b.lo));
}

function finalize(c) {
  return { price: c.sum / c.weight, weight: c.weight, members: c.members, lo: c.lo, hi: c.hi };
}

/**
 * Enrich one scenario with an objective TP, switch level, and R:R.
 * @param scenario a ranked scenario ({bias, targets, invalidation, ...})
 * @param ctx { price, structuralLevels?, extraLevels?, tol? }
 *   structuralLevels/extraLevels: [{price, weight?, source?}] (e.g. swing S/R,
 *   or levels projected from higher timeframes).
 */
export function enrichScenario(scenario, ctx) {
  const { price, structuralLevels = [], extraLevels = [], tol = 0.012 } = ctx;
  const dir = scenario.bias === 'up' ? 1 : -1;
  const inDir = (lvl) => (dir > 0 ? lvl.price > price : lvl.price < price);

  // Only the scenario's own PROJECTED targets are eligible to be the TP (`base`).
  // Structure / higher-timeframe levels merely *boost* a nearby projected target —
  // a swing sitting next to current price is not a wave target.
  const candidates = [
    ...scenario.targets.map((t) => ({ price: t.price, weight: ratioWeight(t.ratio), source: `fib ${t.label}`, base: true })),
    ...structuralLevels.map((l) => ({ price: l.price, weight: l.weight ?? 1.5, source: l.source ?? 'structure' })),
    ...extraLevels.map((l) => ({ price: l.price, weight: l.weight ?? 1.2, source: l.source ?? 'htf' })),
  ].filter(inDir);

  const clusters = confluence(candidates, tol);
  const eligible = clusters.filter((c) => c.members.some((m) => m.base));
  // Strongest confluence wins; among comparable weights prefer the nearer level.
  const primary = (eligible.length ? eligible : clusters).length
    ? (eligible.length ? eligible : clusters)
        .slice().sort((a, b) => b.weight - a.weight || Math.abs(a.price - price) - Math.abs(b.price - price))[0]
    : { price: scenario.targets[0]?.price ?? price, weight: 1, members: [] };

  const tp = primary.price;
  const risk = Math.abs(price - scenario.invalidation);
  const reward = Math.abs(tp - price);
  const rr = risk > 0 ? reward / risk : null;

  return {
    ...scenario,
    tp: { price: tp, confluence: primary.weight, members: primary.members, lo: primary.lo, hi: primary.hi },
    switchPrice: tp, // projected end of the active wave = where direction flips
    rr,
    clusters,
  };
}

/** Apply enrichment across a ranked scenario list. */
export function enrichScenarios(ranked, ctx) {
  return ranked.map((s) => enrichScenario(s, ctx));
}

// Canonical Fib ratios are higher-conviction targets than the far extensions.
function ratioWeight(ratio) {
  const strong = [0.5, 0.618, 1.0, 1.618];
  for (const s of strong) if (Math.abs(ratio - s) < 0.03) return 1.4;
  return 1;
}
