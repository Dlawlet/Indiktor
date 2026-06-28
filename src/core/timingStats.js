// ① Empirical leg-duration windows, learned from resolved snapshots.
//
// timing.js ships Fibonacci priors ([0.382,1.618]·legA for B, [0.5,2.0] for C)
// — a placeholder, and time-via-Fibonacci is even shakier than price-via-Fib.
// Once the loop has resolved forecasts, we can replace those priors with the
// durations that ACTUALLY worked: per segment (TF[, type]), the [p20,p80] band
// of observed legB/legA and legC/legA bar-count ratios among 'hit' outcomes.
//
// Below MIN_TIMING_N samples a segment is omitted, so timing.js falls back to
// the Fibonacci prior — the windows stay soft and never block. Pure module.

import { segmentKey } from './params.js';

export const MIN_TIMING_N = 12;

function pct(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function timingWindows(snapshots, { minN = MIN_TIMING_N } = {}) {
  const acc = {}; // seg → { b:[ratios], c:[ratios] }
  for (const s of snapshots ?? []) {
    const tf = s.tf ?? s.params?.tf ?? '?';
    for (const h of s.hypotheses ?? []) {
      if (h.outcome !== 'hit') continue;                  // only timings that worked
      const a = h.anchor;
      if (!a?.O || !a?.A || !a?.B) continue;
      if (a.O.index == null || a.A.index == null || a.B.index == null) continue;
      const legA = Math.abs(a.A.index - a.O.index);
      if (!legA) continue;
      const seg = segmentKey(tf, h.typeBranch?.[0] ?? null);
      const e = (acc[seg] ??= { b: [], c: [] });
      e.b.push(Math.abs(a.B.index - a.A.index) / legA);
      if (a.C && a.C.index != null) e.c.push(Math.abs(a.C.index - a.B.index) / legA);
    }
  }

  const out = {};
  for (const [seg, e] of Object.entries(acc)) {
    if (e.b.length < minN) continue;
    const bs = e.b.slice().sort((x, y) => x - y);
    const win = { b: [pct(bs, 0.20), pct(bs, 0.80)], bMedian: pct(bs, 0.50), n: e.b.length };
    if (e.c.length >= minN) {
      const cs = e.c.slice().sort((x, y) => x - y);
      win.c = [pct(cs, 0.20), pct(cs, 0.80)];
      win.cMedian = pct(cs, 0.50);
    }
    out[seg] = win;
  }
  return out;
}

// Resolve the best-matching window for a hypothesis: exact (tf,type) first, then
// (tf) alone, else null (caller uses Fibonacci priors).
export function windowFor(windows, tf, hyp) {
  if (!windows) return null;
  const t = hyp?.typeBranch?.[0] ?? null;
  return windows[segmentKey(tf, t)] ?? windows[segmentKey(tf, null)] ?? null;
}
