// Orchestration: fetch every timeframe -> run the wave engine per timeframe ->
// fractal alignment + per-timeframe scenarios -> render. Tabs switch the active
// timeframe without refetching.
import { fetchKlines } from '../core/data.js';
import { TIMEFRAMES, runTimeframe, alignTimeframes } from '../core/multiframe.js';
import { snapshotAnalysis } from '../feedback/snapshot.js';
import { createStore } from '../feedback/store.js';
import { createWaveChart } from './chart.js';

const symbol = () => el('asset').value;
const THEME_KEY = 'wave-engine-theme';
const feedbackStore = createStore();

const el = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const leanClass = (label) => (label === 'bullish' ? 'up' : label === 'bearish' ? 'down' : 'mixed');

let waveChart;
let results = {};
let activeTf = '1d';
let selectedIdx = null;
let lockedIdx = null;
let isDark = (localStorage.getItem(THEME_KEY) ?? 'dark') === 'dark';

function applyTheme() {
  document.body.classList.toggle('light', !isDark);
  el('theme-toggle').textContent = isDark ? '☀' : '🌙';
  if (waveChart) waveChart.setTheme(isDark);
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
}

applyTheme();

async function run() {
  const sensitivity = +el('sensitivity').value;
  document.title = `${symbol()} · Wave Engine`;
  setStatus('Fetching candles across all timeframes…');

  let datasets;
  try {
    datasets = await Promise.all(TIMEFRAMES.map((tf) =>
      fetchKlines(symbol(), tf.interval, tf.limit).then((candles) => ({ tf, candles }))));
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
  selectedIdx = null;
  renderTabs();
  renderActive();
  setStatus(`updated ${new Date().toLocaleTimeString()} · ${symbol()}`);
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
    b.addEventListener('click', () => {
      activeTf = b.dataset.tf;
      selectedIdx = null;
      renderTabs();
      renderActive();
    }));
}

function renderActive() {
  const r = results[activeTf];
  if (!r) return;
  if (!waveChart) waveChart = createWaveChart(el('chart'), isDark);
  waveChart.setCandles(r.candles);
  waveChart.setZigzag(r.pivots);
  waveChart.clearOverlays();
  waveChart.clearWaveLabels();
  r.ranked.slice(0, 3).forEach((s, i) => waveChart.drawScenario(s, i));
  // Auto-show the primary scenario's channel (the "flag/tunnel") and wave labels
  // so the structure is visible without having to click a card.
  const top = r.ranked[0];
  if (top?.anchorPivots?.length >= 3) {
    waveChart.drawChannel(top.anchorPivots, waveChart.scenarioColor(0) + '50');
  }
  if (top?.anchorPivots && top?.waveLabels) {
    waveChart.setWaveLabels(top.anchorPivots, top.waveLabels);
  }
  waveChart.fit();
  renderLean(r.lean);
  renderScenarios(r.ranked);
  // Re-apply lock if one is set and the scenario still exists in this TF
  if (lockedIdx != null && r.ranked[lockedIdx]) {
    waveChart.highlightScenario(r.ranked[lockedIdx], lockedIdx);
    renderWavePosition(r.ranked[lockedIdx]);
  } else if (lockedIdx != null) {
    // Locked scenario doesn't exist in this TF — show default but keep lock state
    lockedIdx = null;
    renderWavePosition(null);
  } else {
    renderWavePosition(null);
  }
}

function renderLean(lean) {
  const node = el('lean');
  node.className = `lean ${leanClass(lean.label)}`;
  node.innerHTML =
    `<span class="lean-label">${lean.label.toUpperCase()}</span>` +
    `<span class="lean-bar"><i style="width:${(lean.up * 100).toFixed(0)}%"></i></span>` +
    `<span class="lean-nums">▲ ${(lean.up * 100).toFixed(0)}% / ▼ ${(lean.down * 100).toFixed(0)}%</span>`;
}

function renderWavePosition(scenario) {
  const node = el('wave-position');
  if (!scenario) {
    node.style.display = 'none';
    return;
  }
  const cls = scenario.bias === 'up' ? 'up' : 'down';
  const arrow = scenario.bias === 'up' ? '▲' : '▼';
  node.style.display = 'flex';
  node.className = `wave-pos ${cls}`;
  node.innerHTML =
    `<span class="wave-pos-label">📍 ${scenario.currentWave ?? scenario.name}</span>` +
    `<span class="wave-pos-bias ${cls}">${arrow} ${scenario.bias.toUpperCase()}</span>` +
    `${lockedIdx != null ? '<span class="wave-pos-badge">LOCKED</span>' : ''}` +
    `<span class="wave-pos-hint">click again to reset</span>`;
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
    const isSelected = selectedIdx === i;
    return `
      <div class="card${isSelected ? ' selected' : ''}" style="--accent:${color}" data-idx="${i}">
        <div class="card-head">
          <span class="rank">S${i + 1}</span>
          <span class="name">${s.name}</span>
          <span class="bias ${s.bias}">${s.bias === 'up' ? '▲' : '▼'} ${s.bias}</span>
          <span class="prob">${p}%</span>
          <button class="lock-btn ${lockedIdx === i ? 'locked' : ''}" data-idx="${i}" title="Lock this scenario">${lockedIdx === i ? '🔒' : '🔓'}</button>
        </div>
        <div class="prob-bar"><i style="width:${p}%;background:${color}"></i></div>
        <div class="row"><span class="k">Switch / TP</span><span class="v">$${fmt(s.switchPrice)}${tpConf}</span></div>
        <div class="row"><span class="k">Risk : Reward</span><span class="v">${rr}</span></div>
        <div class="row"><span class="k">Fib zone</span><span class="v">${targetStr}</span></div>
        <div class="row"><span class="k">Invalidation</span><span class="v">$${fmt(s.invalidation)}${invDist}</span></div>
        <div class="rationale">${s.rationale}</div>
      </div>`;
  }).join('');

  // Card click: highlight the scenario on the chart, or deselect if same card.
  wrap.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => {
      const r = results[activeTf];
      const idx = +card.dataset.idx;
      if (selectedIdx === idx) {
        // Deselect: restore default 3-scenario view
        selectedIdx = null;
        waveChart.clearOverlays();
        waveChart.clearWaveLabels();
        r.ranked.slice(0, 3).forEach((s, i) => waveChart.drawScenario(s, i));
        renderWavePosition(null);
        wrap.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
      } else {
        selectedIdx = idx;
        waveChart.highlightScenario(r.ranked[idx], idx);
        renderWavePosition(r.ranked[idx]);
        wrap.querySelectorAll('.card').forEach((c, i) =>
          c.classList.toggle('selected', i === idx));
      }
    });
  });

  wrap.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = results[activeTf];
      const idx = +btn.dataset.idx;
      if (lockedIdx === idx) {
        // Unlock: clear the lock and go back to default view
        lockedIdx = null;
        selectedIdx = null;
        waveChart.clearOverlays();
        waveChart.clearWaveLabels();
        r.ranked.slice(0, 3).forEach((s, i) => waveChart.drawScenario(s, i));
        renderWavePosition(null);
      } else {
        // Lock: highlight this scenario
        lockedIdx = idx;
        selectedIdx = idx;
        waveChart.highlightScenario(r.ranked[idx], idx);
        renderWavePosition(r.ranked[idx]);
      }
      renderScenarios(r.ranked); // re-render cards to update lock icons
    });
  });
}

async function snapshotActive() {
  const r = results[activeTf];
  if (!r) return;
  try {
    const snap = snapshotAnalysis(r.ranked, { asset: symbol(), timeframe: activeTf, priceAtAnalysis: r.price });
    await feedbackStore.put({ id: snap.id, snapshot: snap, outcomes: {} });
    setStatus(`📸 snapshot saved · ${symbol()} ${activeTf} · open Review to resolve it later`);
  } catch (e) {
    setStatus(`Snapshot failed: ${e.message}`, true);
  }
}

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

el('theme-toggle').addEventListener('click', () => { isDark = !isDark; applyTheme(); });
el('asset').addEventListener('change', () => { results = {}; selectedIdx = null; lockedIdx = null; run(); });
el('sensitivity').addEventListener('change', run);
el('refresh').addEventListener('click', run);
el('snapshot').addEventListener('click', snapshotActive);
run();
