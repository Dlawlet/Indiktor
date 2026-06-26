// Orchestration: fetch every timeframe -> run the wave engine per timeframe ->
// fractal alignment + per-timeframe scenarios -> render. Tabs switch the active
// timeframe without refetching.
import { fetchKlines } from '../core/data.js';
import { TIMEFRAMES, runTimeframe, alignTimeframes } from '../core/multiframe.js';
import { snapshotAnalysis } from '../feedback/snapshot.js';
import { createStore } from '../feedback/store.js';
import { createWaveChart } from './chart.js';

const SYMBOL = 'BTCUSDT';
const feedbackStore = createStore();

const el = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const leanClass = (label) => (label === 'bullish' ? 'up' : label === 'bearish' ? 'down' : 'mixed');

let waveChart;
let results = {};      // tfId -> { tf, candles, pivots, ranked, lean, price }
let activeTf = '1d';

async function run() {
  const sensitivity = +el('sensitivity').value; // ATR multiplier, applied to all TFs
  setStatus('Fetching candles across all timeframes…');

  let datasets;
  try {
    datasets = await Promise.all(TIMEFRAMES.map((tf) =>
      fetchKlines(SYMBOL, tf.interval, tf.limit).then((candles) => ({ tf, candles }))));
  } catch (e) {
    setStatus(`Data error: ${e.message}`, true);
    return;
  }

  results = {};
  for (const { tf, candles } of datasets) {
    results[tf.id] = { tf, candles, ...runTimeframe(candles, { atrMult: sensitivity, atrPeriod: 14 }) };
  }

  const alignment = alignTimeframes(
    TIMEFRAMES.map((tf) => ({ id: tf.id, weight: tf.weight, lean: results[tf.id].lean })));

  el('price').textContent = `$${fmt(results['1d'].price)}`;
  renderAlignment(alignment);
  renderTabs();
  renderActive();
  setStatus(`updated ${new Date().toLocaleTimeString()} · ${SYMBOL}`);
}

function renderAlignment(a) {
  const chips = TIMEFRAMES.map((tf) => {
    const lean = results[tf.id].lean;
    const cls = leanClass(lean.label);
    const arrow = lean.label === 'bullish' ? '▲' : lean.label === 'bearish' ? '▼' : '·';
    return `<span class="tf-chip ${cls}">${tf.id} ${arrow}</span>`;
  }).join('');
  const cls = Math.abs(a.weightedNet) < 0.1 ? 'mixed' : a.dir === 'up' ? 'up' : 'down';
  const node = el('alignment');
  node.className = `lean ${cls}`;
  node.innerHTML =
    `<span class="lean-label">${a.label.toUpperCase()}</span>` +
    `<span class="tf-chips">${chips}</span>` +
    `<span class="lean-nums">net ${(a.weightedNet * 100).toFixed(0)} · agree ${(a.agreement * 100).toFixed(0)}%</span>`;
}

function renderTabs() {
  const wrap = el('tabs');
  wrap.innerHTML = TIMEFRAMES.map((tf) =>
    `<button class="tab ${tf.id === activeTf ? 'active' : ''}" data-tf="${tf.id}">${tf.id}</button>`).join('');
  wrap.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => { activeTf = b.dataset.tf; renderTabs(); renderActive(); }));
}

function renderActive() {
  const r = results[activeTf];
  if (!r) return;
  if (!waveChart) waveChart = createWaveChart(el('chart'));
  waveChart.setCandles(r.candles);
  waveChart.setZigzag(r.pivots);
  waveChart.clearOverlays();
  r.ranked.slice(0, 3).forEach((s, i) => waveChart.drawScenario(s, i));
  waveChart.fit();
  renderLean(r.lean);
  renderScenarios(r.ranked);
}

function renderLean(lean) {
  const node = el('lean');
  node.className = `lean ${leanClass(lean.label)}`;
  node.innerHTML =
    `<span class="lean-label">${lean.label.toUpperCase()}</span>` +
    `<span class="lean-bar"><i style="width:${(lean.up * 100).toFixed(0)}%"></i></span>` +
    `<span class="lean-nums">▲ ${(lean.up * 100).toFixed(0)}% / ▼ ${(lean.down * 100).toFixed(0)}%</span>`;
}

function renderScenarios(ranked) {
  const wrap = el('scenarios');
  if (!ranked.length) { wrap.innerHTML = '<p class="muted">No valid wave structure at this sensitivity.</p>'; return; }

  wrap.innerHTML = ranked.map((s, i) => {
    const color = waveChart.scenarioColor(i);
    const p = (s.probability * 100).toFixed(0);
    const targetStr = s.targets.map((t) => `$${fmt(t.price)} <em>(${t.label})</em>`).join(' · ');
    const invDist = s.invalidationPct != null ? ` <span class="muted">(${pct(s.invalidationPct)})</span>` : '';
    const tpConf = s.tp?.confluence ? ` <em>(conf ${s.tp.confluence.toFixed(1)})</em>` : '';
    const rr = s.rr != null
      ? `<span class="rr ${s.rr >= 2 ? 'good' : s.rr >= 1 ? 'ok' : 'bad'}">${s.rr.toFixed(1)} : 1</span>`
      : '—';
    return `
      <div class="card" style="--accent:${color}">
        <div class="card-head">
          <span class="rank">S${i + 1}</span>
          <span class="name">${s.name}</span>
          <span class="bias ${s.bias}">${s.bias === 'up' ? '▲' : '▼'} ${s.bias}</span>
          <span class="prob">${p}%</span>
        </div>
        <div class="prob-bar"><i style="width:${p}%;background:${color}"></i></div>
        <div class="row"><span class="k">Switch / TP</span><span class="v">$${fmt(s.switchPrice)}${tpConf}</span></div>
        <div class="row"><span class="k">Risk : Reward</span><span class="v">${rr}</span></div>
        <div class="row"><span class="k">Fib zone</span><span class="v">${targetStr}</span></div>
        <div class="row"><span class="k">Invalidation</span><span class="v">$${fmt(s.invalidation)}${invDist}</span></div>
        <div class="rationale">${s.rationale}</div>
      </div>`;
  }).join('');
}

// Snapshot the ACTIVE timeframe's scenarios so the outcome can be reviewed later.
// On demand (button) rather than every refresh, to avoid flooding the dataset.
async function snapshotActive() {
  const r = results[activeTf];
  if (!r) return;
  try {
    const snap = snapshotAnalysis(r.ranked, { asset: SYMBOL, timeframe: activeTf, priceAtAnalysis: r.price });
    await feedbackStore.put({ id: snap.id, snapshot: snap, outcomes: {} });
    setStatus(`📸 snapshot saved · ${SYMBOL} ${activeTf} · open Review to resolve it later`);
  } catch (e) {
    setStatus(`Snapshot failed: ${e.message}`, true);
  }
}

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

el('sensitivity').addEventListener('change', run);
el('refresh').addEventListener('click', run);
el('snapshot').addEventListener('click', snapshotActive);
run();
