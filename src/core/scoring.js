// Convert raw scenarios into ranked, normalized probabilities.
//
// IMPORTANT: these are model-derived *confidence* weights (Elliott prior × rule/
// Fibonacci quality), NOT statistically calibrated probabilities. Calibration
// against historical outcomes is a later phase — label them as such in the UI.

/**
 * Rank scenarios and assign probabilities that sum to 1.
 * weight = prior × (0.35 + 0.65·guideline); a hard-rule failure collapses it to ~0.
 */
export function rankScenarios(analysis) {
  const livePrice = analysis.live?.price ?? null;

  const scored = analysis.scenarios.map((s) => {
    const ruleOk = !(s.rules?.failed?.length);
    const base = s.prior * (0.35 + 0.65 * clamp01(s.guideline));
    return { ...s, weight: ruleOk ? base : base * 0.05 };
  });

  const total = scored.reduce((a, b) => a + b.weight, 0) || 1;

  const ranked = scored
    .map((s) => ({ ...s, probability: s.weight / total }))
    .sort((a, b) => b.probability - a.probability);

  for (const s of ranked) {
    if (livePrice != null && Number.isFinite(s.invalidation)) {
      s.invalidationPct = (s.invalidation - livePrice) / livePrice;
    }
  }
  return ranked;
}

/** Aggregate probability mass per direction ('up' vs 'down'). */
export function directionalLean(ranked) {
  const lean = { up: 0, down: 0 };
  for (const s of ranked) lean[s.bias] = (lean[s.bias] ?? 0) + s.probability;
  const net = lean.up - lean.down;
  return { ...lean, net, label: net > 0.15 ? 'bullish' : net < -0.15 ? 'bearish' : 'mixed' };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
