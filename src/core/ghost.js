// Ghost-candle synthesis for predictive hypothesis visualisation.
//
// Generates a schematic OHLC sequence tracing the expected price path:
//   Segment 1 (forming stage): livePrice → completion zone centre  (C target)
//   Segment 2 (continuation) : C target  → TP extreme
//
// Candles are deterministic (no random noise) — they convey direction and
// approximate pace, not a precise forecast.  Wicks are proportional to the
// candle body so the result looks like a clean impulsive move.
//
// Returns { candles: OHLC[], pivots: { time, price, label, dir }[] }
// where `pivots` are the waypoint markers to pass to chart.drawGhostCandles.

export function generateGhostCandles(hyp, livePrice, candles) {
  if (!candles?.length || !hyp?.anchor) return { candles: [], pivots: [] };

  const barDur = candles.length >= 2
    ? candles[1].time - candles[0].time
    : 3600;  // default 1h

  const currentTime = candles[candles.length - 1].time;
  const { O, A }    = hyp.anchor;
  if (!O || !A) return { candles: [], pivots: [] };

  const legADur  = Math.abs(A.time - O.time);
  const legABars = Math.max(3, Math.round(legADur / barDur));

  // ── Waypoints (time, price, label) ──────────────────────────────────────────
  const wps = [{ time: currentTime, price: livePrice, label: null }];

  const soft = hyp.zones?.invalidation?.soft;
  const tp   = hyp.zones?.tp;

  // Phase 1: current → C (only when a completion zone exists)
  if (hyp.stage !== 'awaiting2°' && soft) {
    const cTarget = (soft[0] + soft[1]) / 2;
    const cBars   = Math.max(3, Math.round(legABars * 0.85));
    wps.push({ time: currentTime + cBars * barDur, price: cTarget, label: 'C' });
  }

  // Phase 2: C (or current) → TP
  if (tp) {
    const tpTarget = hyp.bias === 'bull' ? tp[0] : tp[1];
    const base     = wps[wps.length - 1];
    const tpBars   = Math.max(3, Math.round(legABars * 1.1));
    wps.push({ time: base.time + tpBars * barDur, price: tpTarget, label: 'TP' });
  }

  if (wps.length < 2) return { candles: [], pivots: [] };

  // ── OHLC interpolation ───────────────────────────────────────────────────────
  const ghostCandles = [];
  for (let seg = 0; seg < wps.length - 1; seg++) {
    const from  = wps[seg];
    const to    = wps[seg + 1];
    const nBars = Math.max(2, Math.round((to.time - from.time) / barDur));
    const segMove = to.price - from.price;

    for (let i = 0; i < nBars; i++) {
      const t0    = i / nBars;
      const t1    = (i + 1) / nBars;
      const open  = from.price + segMove * t0;
      const close = from.price + segMove * t1;
      // Wick = 25% of body size, minimum 0.05% of price to stay visible
      const body  = Math.abs(close - open);
      const wick  = Math.max(body * 0.25, Math.abs(segMove) / nBars * 0.05);
      ghostCandles.push({
        time:  from.time + i * barDur,
        open,
        close,
        high:  Math.max(open, close) + wick,
        low:   Math.min(open, close) - wick,
      });
    }
  }

  // ── Projected pivot markers (exclude the start waypoint) ────────────────────
  const projPivots = wps.slice(1).map(wp => ({
    time:  wp.time,
    price: wp.price,
    label: wp.label,
    dir:   wp.price >= livePrice ? 'up' : 'down',
  }));

  return { candles: ghostCandles, pivots: projPivots };
}
