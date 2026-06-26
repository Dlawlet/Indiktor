// Orchestration: fetch -> zigzag -> wave analysis -> ranked scenarios -> render.
import { fetchKlines } from '../core/data.js';
import { zigzag } from '../core/zigzag.js';
import { analyze } from '../core/elliott.js';
import { rankScenarios, directionalLean } from '../core/scoring.js';
import { createWaveChart } from './chart.js';

const SYMBOL = 'BTCUSDT';
const INTERVAL = '1d';
const LIMIT = 1000;

const el = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;

let waveChart;

async function run() {
  const sensitivity = +el('sensitivity').value; // ATR multiplier
  setStatus('Fetching BTC daily candles…');

  let candles;
  try {
    candles = await fetchKlines(SYMBOL, INTERVAL, LIMIT);
  } catch (e) {
    setStatus(`Data error: ${e.message}`, true);
    return;
  }

  const pivots = zigzag(candles, { atrMult: sensitivity, atrPeriod: 14 });
  const analysis = analyze(pivots);
  const ranked = rankScenarios(analysis);
  const lean = directionalLean(ranked);

  const last = candles[candles.length - 1];
  el('price').textContent = `$${fmt(last.close)}`;

  if (!waveChart) waveChart = createWaveChart(el('chart'));
  waveChart.setCandles(candles);
  waveChart.setZigzag(pivots);
  waveChart.clearOverlays();
  ranked.slice(0, 3).forEach((s, i) => waveChart.drawScenario(s, i));
  waveChart.fit();

  renderLean(lean);
  renderScenarios(ranked, last.close);
  setStatus(`${candles.length} candles · ${pivots.length} pivots · updated ${new Date().toLocaleTimeString()}`);
}

function renderLean(lean) {
  const node = el('lean');
  const cls = lean.label === 'bullish' ? 'up' : lean.label === 'bearish' ? 'down' : 'mixed';
  node.className = `lean ${cls}`;
  node.innerHTML =
    `<span class="lean-label">${lean.label.toUpperCase()}</span>` +
    `<span class="lean-bar"><i style="width:${(lean.up * 100).toFixed(0)}%"></i></span>` +
    `<span class="lean-nums">▲ ${(lean.up * 100).toFixed(0)}% / ▼ ${(lean.down * 100).toFixed(0)}%</span>`;
}

function renderScenarios(ranked, price) {
  const wrap = el('scenarios');
  if (!ranked.length) { wrap.innerHTML = '<p class="muted">No valid wave structure found at this sensitivity.</p>'; return; }

  wrap.innerHTML = ranked.map((s, i) => {
    const color = waveChart.scenarioColor(i);
    const p = (s.probability * 100).toFixed(0);
    const targetStr = s.targets.map((t) => `$${fmt(t.price)} <em>(${t.label})</em>`).join(' · ');
    const invDist = s.invalidationPct != null ? ` <span class="muted">(${pct(s.invalidationPct)})</span>` : '';
    return `
      <div class="card" style="--accent:${color}">
        <div class="card-head">
          <span class="rank">S${i + 1}</span>
          <span class="name">${s.name}</span>
          <span class="bias ${s.bias}">${s.bias === 'up' ? '▲' : '▼'} ${s.bias}</span>
          <span class="prob">${p}%</span>
        </div>
        <div class="prob-bar"><i style="width:${p}%;background:${color}"></i></div>
        <div class="row"><span class="k">Targets</span><span class="v">${targetStr}</span></div>
        <div class="row"><span class="k">Invalidation</span><span class="v">$${fmt(s.invalidation)}${invDist}</span></div>
        <div class="rationale">${s.rationale}</div>
      </div>`;
  }).join('');
}

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

el('sensitivity').addEventListener('change', run);
el('refresh').addEventListener('click', run);
run();
