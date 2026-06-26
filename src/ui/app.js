// Orchestration: fetch every timeframe -> run the wave engine per timeframe ->
// fractal alignment + per-timeframe scenarios -> render. Tabs switch the active
// timeframe without refetching.
import { fetchKlines } from '../core/data.js';
import { TIMEFRAMES, runTimeframe, alignTimeframes } from '../core/multiframe.js';
import { snapshotAnalysis } from '../feedback/snapshot.js';
import { resolveSnapshot } from '../feedback/resolve.js';
import { createStore } from '../feedback/store.js';
import { createWaveChart } from './chart.js';
import { projectGhostCandles } from '../core/forecast.js';
import { scanHistoricalFlats } from '../core/scanner.js';

const symbol = () => el('asset').value;
const THEME_KEY = 'wave-engine-theme';
const SNAP_KEY  = 'wave-engine-last-snap';
const SNAP_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const INTERVAL_SECONDS = { '1m': 60, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
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
let histOn = false;

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
  autoSnapshotAndResolve();
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

function computeATR(candles, period = 14) {
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + (c.high - c.low), 0) / slice.length;
}

function _drawExtras(r, scenario, idx) {
  // Pattern shape
  if (scenario.anchorPivots) {
    waveChart.drawPatternShape(scenario, scenario.anchorPivots);
  }
  // Ghost candles
  if (scenario.targets?.length > 0) {
    const atr = computeATR(r.candles);
    const lastCandle = r.candles[r.candles.length - 1];
    const intervalSec = INTERVAL_SECONDS[activeTf] ?? 3600;
    const { candles: ghostCandles, projectedPivots } = projectGhostCandles({
      scenario,
      anchorPivots: scenario.anchorPivots,
      currentPrice: lastCandle.close,
      atr,
      lastTime: lastCandle.time,
      intervalSec,
    });
    waveChart.drawGhostCandles(ghostCandles, projectedPivots, waveChart.scenarioColor(idx));
  }
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
  const top = r.ranked[0];
  if (top?.anchorPivots && top?.waveLabels) {
    waveChart.setWaveLabels(top.anchorPivots, top.waveLabels);
  }
  // Draw channel bounds for top 3 scenarios, extended one full channel-length
  // past the last known anchor so the flag zone projects forward visibly.
  const lastCandle     = r.candles[r.candles.length - 1];
  const intervalSec    = INTERVAL_SECONDS[activeTf] ?? 3600;
  const channelOpacity = ['55', '38', '22'];
  r.ranked.slice(0, 3).forEach((s, i) => {
    if (s.anchorPivots?.length >= 3) {
      const [a,,c] = s.anchorPivots.slice(-3);
      const extendTo = Math.max(lastCandle.time, c.time) + (c.time - a.time);
      waveChart.drawChannel(s.anchorPivots, waveChart.scenarioColor(i) + channelOpacity[i], extendTo);
    }
  });
  waveChart.fit();
  renderLean(r.lean);
  renderScenarios(r.ranked);
  if (histOn) applyHistOverlay();
  // Re-apply lock if one is set and the scenario still exists in this TF
  if (lockedIdx != null && r.ranked[lockedIdx]) {
    waveChart.highlightScenario(r.ranked[lockedIdx], lockedIdx);
    _drawExtras(r, r.ranked[lockedIdx], lockedIdx);
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
    const macroBadge = s.degree === 'macro' ? '<span class="macro-badge">MACRO</span>' : '';
    return `
      <div class="card${isSelected ? ' selected' : ''}" style="--accent:${color}" data-idx="${i}">
        <div class="card-head">
          <span class="rank">S${i + 1}</span>
          <span class="name">${s.name}</span>${macroBadge}
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
        _drawExtras(r, r.ranked[idx], idx);
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
        _drawExtras(r, r.ranked[idx], idx);
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
    localStorage.setItem(SNAP_KEY, Date.now().toString());
    setStatus(`📸 snapshot saved · ${symbol()} ${activeTf} · open Review to resolve it later`);
  } catch (e) {
    setStatus(`Snapshot failed: ${e.message}`, true);
  }
}

/** Auto-snapshot all loaded timeframes + resolve pending snapshots, at most once per 3 h. */
async function autoSnapshotAndResolve() {
  const last = +localStorage.getItem(SNAP_KEY) || 0;
  if (Date.now() - last < SNAP_INTERVAL_MS) return;
  localStorage.setItem(SNAP_KEY, Date.now().toString());

  // Snapshot every loaded timeframe so we capture all fractal degrees
  for (const tf of TIMEFRAMES) {
    const r = results[tf.id];
    if (!r?.ranked?.length) continue;
    try {
      const snap = snapshotAnalysis(r.ranked, { asset: symbol(), timeframe: tf.id, priceAtAnalysis: r.price });
      await feedbackStore.put({ id: snap.id, snapshot: snap, outcomes: {} });
    } catch (_) { /* non-fatal */ }
  }

  // Resolve all pending snapshots using the freshest candles we already have
  try {
    const records = await feedbackStore.all();
    for (const rec of records) {
      const hasPending = Object.values(rec.outcomes).some(o => o.outcome === 'pending') ||
                         Object.keys(rec.outcomes).length === 0;
      if (!hasPending) continue;
      const tfData = results[rec.snapshot.timeframe];
      if (!tfData?.candles?.length) continue;
      // Only use candles that printed AFTER the snapshot was taken
      const later = tfData.candles.filter(c => c.time > rec.snapshot.takenAt / 1000);
      if (!later.length) continue;
      const resolved = resolveSnapshot(rec.snapshot, later);
      const newOutcomes = { ...rec.outcomes };
      for (const res of resolved.resolutions) {
        if (res.outcome !== 'pending') {
          newOutcomes[res.scenarioId] = { outcome: res.outcome, resolver: 'auto', price: res.price, time: res.time, reason: res.reason };
        }
      }
      await feedbackStore.put({ ...rec, outcomes: newOutcomes, updatedTs: Math.floor(Date.now() / 1000) });
    }
  } catch (_) { /* non-fatal */ }
}

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

function applyHistOverlay() {
  if (!waveChart) return;
  const r = results[activeTf];
  if (!r?.candles) return;
  if (histOn) {
    const sensitivity = +el('sensitivity').value;
    // minSpan=30: require A+B to span at least 30 candles — eliminates spike-to-spike
    // false detections while preserving true structural flat channels (30c = 30h on 1h,
    // 5 days on 4h, etc.)
    const patterns = scanHistoricalFlats(r.candles, { atrMult: sensitivity, minSpan: 30 });
    waveChart.drawHistoricalFlats(patterns, r.candles);
    const byType = patterns.reduce((acc, p) => {
      acc[p.type] = (acc[p.type] ?? 0) + 1;
      return acc;
    }, {});
    const bull = patterns.filter((p) => p.market === 'bull').length;
    const bear = patterns.length - bull;
    setStatus(
      `Historical flags: ${patterns.length} · ` +
      `regular ${byType.regular ?? 0}, running ${byType.running ?? 0}, ` +
      `expanding ${byType.expanding ?? 0}, contracting ${byType.contracting ?? 0} · ` +
      `bull ${bull} / bear ${bear}`
    );
  } else {
    waveChart.clearHistoricalFlats();
  }
  const btn = el('hist-toggle');
  btn.textContent = histOn ? 'HIST ON' : 'HIST OFF';
  btn.classList.toggle('on', histOn);
}

el('theme-toggle').addEventListener('click', () => { isDark = !isDark; applyTheme(); });
el('asset').addEventListener('change', () => { results = {}; selectedIdx = null; lockedIdx = null; run(); });
el('sensitivity').addEventListener('change', run);
el('refresh').addEventListener('click', run);
el('snapshot').addEventListener('click', snapshotActive);
el('hist-toggle').addEventListener('click', () => { histOn = !histOn; applyHistOverlay(); });
run();
