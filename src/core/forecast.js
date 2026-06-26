/**
 * Generate ghost-candle OHLC data projecting from currentPrice toward targetPrice.
 * Uses a deterministic oscillating path (no Math.random — same candles every render).
 *
 * @param {object} opts
 * @param {number} opts.currentPrice   last real close price
 * @param {number} opts.targetPrice    primary target price
 * @param {number} opts.atr            average true range (candle-level, same TF)
 * @param {number} opts.lastTime       unix seconds of the last real candle
 * @param {number} opts.intervalSec    seconds per candle (60, 3600, 14400, 86400)
 * @returns {Array<{time,open,high,low,close}>}
 */
export function projectGhostCandles({ currentPrice, targetPrice, atr, lastTime, intervalSec }) {
  const dir = targetPrice > currentPrice ? 1 : -1;
  const dist = Math.abs(targetPrice - currentPrice);
  if (dist < atr * 0.5) return [];  // target too close, skip

  // Estimate candle count: each candle moves ~half ATR net on average
  const count = Math.max(8, Math.min(30, Math.round(dist / (atr * 0.5))));
  const candles = [];
  let prevClose = currentPrice;

  for (let i = 0; i < count; i++) {
    const t = lastTime + (i + 1) * intervalSec;
    const progress = (i + 1) / count;

    // Ease-in-out S-curve for smooth approach
    const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

    // Deterministic oscillation (sin wave scaled to ATR, no random)
    const oscillation = Math.sin(i * 1.9) * atr * 0.18;
    const close = currentPrice + dir * dist * eased + oscillation;
    const open = prevClose;

    const bodyHalf = Math.abs(close - open) * 0.1 + atr * 0.08;
    const high = Math.max(open, close) + bodyHalf;
    const low  = Math.min(open, close) - bodyHalf;

    candles.push({ time: t, open, high, low, close });
    prevClose = close;
  }
  return candles;
}
