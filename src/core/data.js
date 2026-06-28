// Binance kline fetching + candle normalization.
// Pure helpers (normalize, resample) are unit-tested; fetch* hit the network.

const BINANCE_SPOT = 'https://api.binance.com/api/v3/klines';
const MAX_PER_REQ = 1000; // Binance hard cap per klines request

/**
 * Map a raw Binance kline array to a candle object.
 * Raw: [openTime, open, high, low, close, volume, closeTime, ...]
 * @returns {{time:number, open:number, high:number, low:number, close:number, volume:number}}
 *   `time` is the candle OPEN time in seconds (Lightweight Charts uses seconds).
 */
export function normalizeKline(raw) {
  return {
    time: Math.floor(raw[0] / 1000),
    open: +raw[1],
    high: +raw[2],
    low: +raw[3],
    close: +raw[4],
    volume: +raw[5],
  };
}

/**
 * Aggregate `factor` consecutive candles into one (e.g. 2x 5m -> 10m).
 * Trailing partial groups are dropped. Assumes ascending, gap-free input.
 */
export function resample(candles, factor) {
  if (factor <= 1) return candles.slice();
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    out.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

/**
 * Fetch `limit` candles of `interval` for `symbol`, paginating backwards so we
 * can exceed Binance's 1000-per-request cap. Returns ascending candles.
 */
export async function fetchKlines(symbol, interval, limit = 1000, fetchImpl = fetch, { timeoutMs = 15000 } = {}) {
  // Per-request abort timeout so a stalled network call fails fast instead of
  // hanging the caller forever (which manifests as a "frozen" app).
  const timeoutSignal = () =>
    (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeoutMs) : undefined;

  const collected = [];
  let endTime; // ms; undefined => most recent
  while (collected.length < limit) {
    const need = Math.min(MAX_PER_REQ, limit - collected.length);
    const url = new URL(BINANCE_SPOT);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(need));
    if (endTime != null) url.searchParams.set('endTime', String(endTime));

    const res = await fetchImpl(url.toString(), { cache: 'no-store', signal: timeoutSignal() });
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol} ${interval}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    collected.unshift(...batch.map(normalizeKline));
    endTime = batch[0][0] - 1; // step before the oldest candle we just got
    if (batch.length < need) break; // no more history available
  }
  // de-dup + ensure ascending by time
  const seen = new Set();
  return collected
    .filter(c => (seen.has(c.time) ? false : seen.add(c.time)))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}
