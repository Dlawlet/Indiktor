'use strict';

const fs = require('fs/promises');
const path = require('path');

const STATE_PATH = process.env.STATE_PATH || path.join('automation', 'state.json');
const THRESHOLD = parseFloat(process.env.THRESHOLD || '0.10'); // 10% relative move

const ASSETS = [
  { key: 'BTC', symbol: 'BTCUSDT', dominanceScore: scoreBTCDom },
  { key: 'ETH', symbol: 'ETHUSDT', dominanceScore: scoreETHDom },
];

async function main() {
  const previous = await readState(STATE_PATH);
  const shared = await fetchShared();

  const computed = {};
  for (const asset of ASSETS) {
    computed[asset.key] = await computeAsset(asset, shared);
  }

  const changes = previous ? findChanges(previous.scores, computed, THRESHOLD) : [];
  const body = buildBody(changes, THRESHOLD, previous?.timestamp);

  const mergedState = mergeState(previous, computed);
  await writeState(STATE_PATH, mergedState);
  await writeOutputs({ changes, body, threshold: THRESHOLD, statePath: STATE_PATH });

  if (changes.length === 0) {
    console.log(`No ${(THRESHOLD * 100).toFixed(0)}% shifts detected.`);
  } else {
    console.log('Changes detected:\n' + body);
  }
}

async function computeAsset(asset, shared) {
  const [premIdx, oiHist, klines] = await Promise.allSettled([
    get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${asset.symbol}`),
    get(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${asset.symbol}&period=1d&limit=30`),
    getKlines(asset.symbol, 1500),
  ]);

  const scores = {};

  if (premIdx.status === 'fulfilled') {
    const d = premIdx.value;
    const rate = +d.lastFundingRate;
    scores.funding = scoreFunding(rate);
    scores.basis = scoreBasis(+d.markPrice, +d.indexPrice);
  } else {
    scores.funding = NaN;
    scores.basis = NaN;
  }

  const closes = klines.status === 'fulfilled' ? klines.value.map(k => +k[4]) : null;

  if (oiHist.status === 'fulfilled') {
    scores.oi = scoreOI(oiHist.value, closes);
  } else {
    scores.oi = NaN;
  }

  if (shared.fng) {
    scores.fng = scoreFnG(+shared.fng.data[0].value);
  } else {
    scores.fng = NaN;
  }

  if (shared.cg) {
    const mcp = shared.cg.data.market_cap_percentage;
    scores.stabledom = scoreStabledom(mcp);
    scores.dom = asset.dominanceScore(mcp);
  } else {
    scores.stabledom = NaN;
    scores.dom = NaN;
  }

  if (closes) {
    const price = closes[closes.length - 1];
    scores.ma200w = score200WMA(closes, price);
    scores.ma2y = score2YMA(closes, price);
    scores.picycle = scorePiCycle(closes);
    scores.puell = scorePuellProxy(closes);
  } else {
    scores.ma200w = scores.ma2y = scores.picycle = scores.puell = NaN;
  }

  const shortTerm = wavg([
    [scores.funding, 25],
    [scores.basis, 20],
    [scores.oi, 15],
    [scores.fng, 30],
    [scores.stabledom, 10],
  ]);

  const longTerm = wavg([
    [scores.ma200w, 25],
    [scores.ma2y, 25],
    [scores.picycle, 20],
    [scores.puell, 20],
    [scores.dom, 10],
  ]);

  return {
    shortTerm: round(shortTerm),
    longTerm: round(longTerm),
  };
}

async function fetchShared() {
  const [fng, cg] = await Promise.allSettled([
    get('https://api.alternative.me/fng/?limit=1'),
    get('https://api.coingecko.com/api/v3/global'),
  ]);
  return {
    fng: fng.status === 'fulfilled' ? fng.value : null,
    cg: cg.status === 'fulfilled' ? cg.value : null,
  };
}

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function getKlines(symbol, days) {
  const limit = Math.min(days, 1000);
  const recent = await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`);
  if (days <= 1000) return recent;
  const oldestCloseTime = recent[0][6];
  const extra = await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${Math.min(days - 1000, 1000)}&endTime=${oldestCloseTime - 1}`);
  return [...extra, ...recent];
}

function scoreFunding(rate) {
  const p = rate * 100;
  if (p < -0.05) return 88;
  if (p < 0) return 72;
  if (p < 0.01) return 55;
  if (p < 0.03) return 40;
  if (p < 0.06) return 26;
  return 14;
}

function scoreBasis(mark, index) {
  const p = (mark - index) / index * 100;
  if (p < -0.1) return 80;
  if (p < 0) return 66;
  if (p < 0.3) return 55;
  if (p < 1.0) return 44;
  if (p < 3.0) return 30;
  return 16;
}

function scoreOI(hist, closes) {
  if (!hist || hist.length < 7) return NaN;
  const recent = hist.slice(-7).reduce((a, b) => a + +b.sumOpenInterest, 0) / 7;
  const older = hist.length >= 14
    ? hist.slice(-14, -7).reduce((a, b) => a + +b.sumOpenInterest, 0) / 7
    : hist.slice(0, Math.floor(hist.length / 2)).reduce((a, b) => a + +b.sumOpenInterest, 0) / Math.floor(hist.length / 2);
  const oiChg = (recent - older) / older;

  let priceChg = 0;
  if (closes && closes.length >= 14) {
    const pNow = closes[closes.length - 1];
    const p7ago = closes[closes.length - 8];
    priceChg = (pNow - p7ago) / p7ago;
  }

  const oiUp = oiChg > 0.03;
  const oiDown = oiChg < -0.03;
  const priceUp = priceChg > 0.02;

  if (oiDown && !priceUp) return 72;
  if (oiUp && priceUp) return 58;
  if (oiDown && priceUp) return 46;
  if (oiUp && !priceUp) return 28;
  return 50;
}

function scoreFnG(val) {
  if (val <= 15) return 90;
  if (val <= 25) return 78;
  if (val <= 40) return 64;
  if (val <= 55) return 50;
  if (val <= 65) return 38;
  if (val <= 80) return 24;
  return 12;
}

function scoreStabledom(mcp) {
  const pct = (mcp?.usdt || 0) + (mcp?.usdc || 0);
  if (pct > 14) return 76;
  if (pct > 12) return 64;
  if (pct > 10) return 54;
  if (pct > 8) return 44;
  if (pct > 6) return 34;
  return 22;
}

function score200WMA(closes, price) {
  if (closes.length < 1400) return NaN;
  const ma = closes.slice(-1400).reduce((a, b) => a + b, 0) / 1400;
  const r = price / ma;
  if (r < 1.0) return 92;
  if (r < 1.5) return 74;
  if (r < 2.5) return 56;
  if (r < 4.0) return 38;
  if (r < 6.0) return 24;
  return 14;
}

function score2YMA(closes, price) {
  if (closes.length < 730) return NaN;
  const ma = closes.slice(-730).reduce((a, b) => a + b, 0) / 730;
  const r = price / ma;
  if (r < 0.8) return 90;
  if (r < 1.0) return 80;
  if (r < 1.3) return 62;
  if (r < 1.6) return 50;
  if (r < 2.0) return 34;
  return 18;
}

function scorePiCycle(closes) {
  if (closes.length < 360) return NaN;
  const ma111 = closes.slice(-111).reduce((a, b) => a + b, 0) / 111;
  const ma350 = closes.slice(-350).reduce((a, b) => a + b, 0) / 350;
  const r = ma111 / (2 * ma350);
  if (r >= 1.0) return 8;
  if (r >= 0.97) return 20;
  if (r >= 0.93) return 34;
  if (r >= 0.87) return 48;
  if (r >= 0.78) return 62;
  if (r >= 0.65) return 72;
  return 82;
}

function scoreBTCDom(mcp) {
  const d = mcp?.btc || 50;
  if (d > 62) return 65;
  if (d > 58) return 60;
  if (d > 54) return 55;
  if (d > 50) return 50;
  if (d > 45) return 44;
  if (d > 40) return 38;
  return 30;
}

function scoreETHDom(mcp) {
  const d = mcp?.eth || 18;
  if (d > 22) return 72;
  if (d > 20) return 64;
  if (d > 18) return 56;
  if (d > 16) return 50;
  if (d > 14) return 44;
  if (d > 12) return 38;
  return 28;
}

function scorePuellProxy(closes) {
  if (closes.length < 400) return NaN;
  const price = closes[closes.length - 1];
  const avg365 = closes.slice(-365).reduce((a, b) => a + b, 0) / 365;
  const pm = price / avg365;
  if (pm < 0.5) return 90;
  if (pm < 0.8) return 74;
  if (pm < 1.2) return 56;
  if (pm < 2.0) return 42;
  if (pm < 3.5) return 28;
  return 14;
}

function wavg(pairs) {
  let ws = 0;
  let sum = 0;
  for (const [s, w] of pairs) {
    if (!isNaN(s) && s !== null) {
      sum += s * w;
      ws += w;
    }
  }
  return ws > 0 ? sum / ws : NaN;
}

function findChanges(previous, current, threshold) {
  if (!previous) return [];
  const entries = [];
  for (const [asset, values] of Object.entries(current)) {
    const prev = previous[asset];
    if (!prev) continue;
    for (const horizon of ['shortTerm', 'longTerm']) {
      const prevVal = prev[horizon];
      const curVal = values[horizon];
      if (!isFinite(prevVal) || !isFinite(curVal) || prevVal === 0) continue;
      const delta = (curVal - prevVal) / prevVal;
      if (Math.abs(delta) >= threshold) {
        entries.push({ asset, horizon, previous: prevVal, current: curVal, change: delta });
      }
    }
  }
  return entries;
}

function buildBody(changes, threshold, previousTimestamp) {
  if (changes.length === 0) {
    return `No changes ≥ ${(threshold * 100).toFixed(0)}% detected this run.`;
  }
  const lines = [];
  lines.push('Indiktor overall score alert');
  lines.push(`Threshold: ${(threshold * 100).toFixed(0)}% relative move`);
  if (previousTimestamp) lines.push(`Compared to snapshot: ${previousTimestamp}`);
  lines.push('');
  for (const c of changes) {
    const label = c.horizon === 'shortTerm' ? 'short term' : 'long term';
    lines.push(`- ${c.asset} ${label}: ${c.previous.toFixed(2)} → ${c.current.toFixed(2)} (${formatPct(c.change)})`);
  }
  lines.push('');
  lines.push('Data sources: Binance Futures/Spot, CoinGecko, alternative.me');
  return lines.join('\n');
}

async function readState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function writeOutputs({ changes, body, threshold, statePath }) {
  const outputPath = process.env.OUTPUT_FILE || process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = [];
  lines.push(`email_needed=${changes.length > 0}`);
  lines.push(`threshold=${(threshold * 100).toFixed(0)}%`);
  lines.push(`state_file=${statePath}`);
  if (changes.length > 0) {
    const subject = `Indiktor alert: ${changes.map(c => `${c.asset} ${c.horizon === 'shortTerm' ? 'ST' : 'LT'}`).join(' / ')} shift`;
    lines.push(`subject=${subject}`);
    lines.push('body<<EOF');
    lines.push(body);
    lines.push('EOF');
  }
  await fs.appendFile(outputPath, lines.join('\n') + '\n');
}

function mergeState(previous, current) {
  const scores = {};
  for (const asset of Object.keys(current)) {
    const prev = previous?.scores?.[asset] || {};
    const cur = current[asset] || {};
    scores[asset] = {
      shortTerm: isFinite(cur.shortTerm) ? cur.shortTerm : prev.shortTerm,
      longTerm: isFinite(cur.longTerm) ? cur.longTerm : prev.longTerm,
    };
  }
  return { timestamp: new Date().toISOString(), scores };
}

function formatPct(change) {
  const pct = change * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function round(val) {
  return isFinite(val) ? Math.round(val * 100) / 100 : NaN;
}

main().catch(err => {
  console.error('Score monitor failed:', err);
  process.exitCode = 1;
});
