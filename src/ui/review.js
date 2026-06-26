// Outcome-review UI controller.
//
// Lists recorded snapshots, shows each scenario's auto-resolved status, and lets
// the user confirm/override the realized outcome for ambiguous or pending cases.
// Human overrides are tagged resolver:'human' and persisted alongside the
// snapshot via the IndexedDB store. Re-running the auto-resolver pulls fresh
// candles and re-decides every scenario that has NOT been human-overridden.
//
// Reuses the dark/cyber CSS from review.html (same variables as index.html).

import { createStore } from '../feedback/store.js';
import { resolveSnapshot } from '../feedback/resolve.js';
import { exportDataset, calibrate } from '../feedback/calibrate.js';
import { fetchKlines } from '../core/data.js';

const THEME_KEY = 'wave-engine-theme';
const el = (id) => document.getElementById(id);
const store = createStore();

let isDark = (localStorage.getItem(THEME_KEY) ?? 'dark') === 'dark';
function applyTheme() {
  document.body.classList.toggle('light', !isDark);
  el('theme-toggle').textContent = isDark ? '☀' : '🌙';
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
}
applyTheme();
el('theme-toggle').addEventListener('click', () => { isDark = !isDark; applyTheme(); });

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
const dt = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toLocaleString() : '—');

const OUTCOMES = ['target-hit', 'invalidated', 'pending'];

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

/** Render the whole page from the store. */
async function render() {
  let records;
  try {
    records = await store.all();
  } catch (e) {
    setStatus(`Store error: ${e.message}`, true);
    return;
  }
  el('count').textContent = `${records.length} snapshot${records.length === 1 ? '' : 's'}`;

  const wrap = el('snapshots');
  if (!records.length) {
    wrap.innerHTML = `<div class="empty">No snapshots yet.<br>
      Open the engine and trigger a snapshot of an analysis (see
      <code>src/feedback/INTEGRATION.md</code>), then come back here to review outcomes.</div>`;
  } else {
    wrap.innerHTML = records.map(renderSnapshot).join('');
    wireOverrides(records);
  }

  renderDataset(records);
}

function renderSnapshot(rec) {
  const snap = rec.snapshot;
  const outcomes = rec.outcomes ?? {};
  const rows = (snap.scenarios ?? []).map((s) => {
    const o = outcomes[s.id] ?? { outcome: 'pending', resolver: 'auto' };
    const prob = `${((s.features?.probability ?? 0) * 100).toFixed(0)}%`;
    const options = OUTCOMES.map(
      (v) => `<option value="${v}"${v === o.outcome ? ' selected' : ''}>${v}</option>`,
    ).join('');
    return `
      <tr>
        <td><span class="sc-name">${s.name}</span>
            <span class="bias ${s.bias}">${s.bias === 'up' ? '▲' : '▼'}</span></td>
        <td>${prob}</td>
        <td>$${fmt(s.invalidation)}</td>
        <td>
          <span class="pill ${o.outcome}">${o.outcome}</span>
          <span class="resolver ${o.resolver}">${o.resolver}</span>
        </td>
        <td>
          <select class="ov" data-snap="${snap.id}" data-sc="${s.id}">${options}</select>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="snap">
      <div class="snap-head">
        <span class="asset">${snap.asset ?? '?'}</span>
        <span class="meta">${snap.timeframe ?? ''} · ${dt(snap.ts)} · @ $${fmt(snap.priceAtAnalysis)}</span>
        <span class="spacer"></span>
        <button class="tiny" data-del="${snap.id}">delete</button>
      </div>
      <table>
        <thead><tr><th>Scenario</th><th>Prob</th><th>Invalidation</th><th>Status</th><th>Override</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Attach change/click handlers for the override selects + delete buttons. */
function wireOverrides(records) {
  const byId = new Map(records.map((r) => [r.snapshot.id, r]));

  el('snapshots').querySelectorAll('select.ov').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const rec = byId.get(sel.dataset.snap);
      if (!rec) return;
      const outcomes = { ...(rec.outcomes ?? {}) };
      outcomes[sel.dataset.sc] = {
        outcome: sel.value,
        resolver: 'human', // user-decided => human-tagged
        time: null,
        price: null,
        reason: 'manual override',
      };
      await store.put({ ...rec, outcomes });
      setStatus(`Override saved: ${rec.snapshot.asset} · ${sel.dataset.sc} → ${sel.value} (human)`);
      render();
    });
  });

  el('snapshots').querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await store.delete(btn.dataset.del);
      setStatus('Snapshot deleted.');
      render();
    });
  });
}

/** Recompute and render the dataset summary + reliability table + JSON preview. */
function renderDataset(records) {
  const dataset = exportDataset(records);
  const model = calibrate(dataset);

  const hits = dataset.filter((d) => d.outcome === 1).length;
  const human = dataset.filter((d) => d.resolver === 'human').length;
  el('dataset-stat').innerHTML =
    `Labeled examples: <b>${dataset.length}</b><br>` +
    `Target-hit: <b>${hits}</b> · Invalidated: <b>${dataset.length - hits}</b><br>` +
    `Human-overridden: <b>${human}</b><br>` +
    `Calibration: <b>${model.fitted ? 'fitted' : `raw (need ≥ ${calibrateMin()} )`}</b>`;

  el('reliability').innerHTML = model.reliability
    .map((b) => {
      const rate = b.hitRate == null ? '—' : `${(b.hitRate * 100).toFixed(0)}%`;
      const w = b.hitRate == null ? 0 : b.hitRate * 100;
      return `<div class="rel-row">
        <span class="lbl">${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}% (n=${b.n})</span>
        <span style="float:right">${rate}</span>
        <div class="relbar"><i style="width:${w}%"></i></div>
      </div>`;
    })
    .join('');

  el('preview').textContent = JSON.stringify(dataset.slice(0, 5), null, 2);
  el('exportBtn').onclick = () => downloadJSON('wave-engine-dataset.json', dataset);
}

// MIN_SAMPLES lives in calibrate.js; surface it without a second import by reading
// the model's own threshold message is not exposed, so re-import lazily.
function calibrateMin() {
  return 30; // mirrors calibrate.MIN_SAMPLES (kept in sync; informational only)
}

function downloadJSON(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Re-run the objective auto-resolver for every snapshot using fresh candles.
 * Only scenarios still on an 'auto' resolver are updated; human overrides stick.
 */
async function autoResolveAll() {
  let records;
  try {
    records = await store.all();
  } catch (e) {
    setStatus(`Store error: ${e.message}`, true);
    return;
  }
  if (!records.length) { setStatus('Nothing to resolve.'); return; }

  // Group by asset+timeframe so we fetch candles once per series.
  const series = new Map();
  for (const r of records) {
    const key = `${r.snapshot.asset}|${r.snapshot.timeframe}`;
    if (!series.has(key)) series.set(key, { asset: r.snapshot.asset, timeframe: r.snapshot.timeframe });
  }

  setStatus('Fetching latest candles…');
  const candlesByKey = new Map();
  for (const [key, { asset, timeframe }] of series) {
    try {
      candlesByKey.set(key, await fetchKlines(asset, timeframe, 1000));
    } catch (e) {
      setStatus(`Fetch failed for ${asset} ${timeframe}: ${e.message}`, true);
    }
  }

  let updated = 0;
  for (const rec of records) {
    const key = `${rec.snapshot.asset}|${rec.snapshot.timeframe}`;
    const candles = candlesByKey.get(key);
    if (!candles) continue;
    const resolved = resolveSnapshot(rec.snapshot, candles);
    const outcomes = { ...(rec.outcomes ?? {}) };
    for (const r of resolved.resolutions) {
      const existing = outcomes[r.scenarioId];
      if (existing && existing.resolver === 'human') continue; // never clobber human
      outcomes[r.scenarioId] = {
        outcome: r.outcome, resolver: 'auto', price: r.price, time: r.time, reason: r.reason,
      };
      updated++;
    }
    await store.put({ ...rec, outcomes });
  }
  setStatus(`Auto-resolved ${updated} scenario(s) across ${records.length} snapshot(s).`);
  render();
}

el('resolveAll').addEventListener('click', autoResolveAll);
render();
