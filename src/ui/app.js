import { fetchKlines } from '../core/data.js';
import { zigzag } from '../core/zigzag.js';
import { createWaveChart } from './chart.js';
import { detectFlatPatterns, detectLiveFlat, FLAT_COLORS, FLAT_LABELS } from '../core/flats.js';
import { enumerateHypotheses, rankAndBeam } from '../core/predict.js';
import { withTiming } from '../core/timing.js';
import { timingWindows } from '../core/timingStats.js';
import { takeSnapshot, evaluateSnapshotPath, computeMetrics } from '../core/snapshot.js';
import { generateGhostPaths } from '../core/ghost.js';
import { patternImageSpec, hypImageSpec } from '../core/imageSpec.js';
import { idbGet, idbSet, idbDel, snapGetAll, snapPut, snapBulkPut } from '../core/idb.js';
import { buildParams, hashParams } from '../core/params.js';

const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'];
// Candle counts chosen so each timeframe spans ≈ 1 month or more where feasible
// (1d/4h/1h/15m ≥ 1 month; 1m is impractical for a month so it's a best-effort
// ~1.4 days). Wider windows mean a pinned scenario from hours ago still has its
// context loaded on return.
const TF_LIMITS = { '1m': 2000, '15m': 2880, '1h': 1000, '4h': 750, '1d': 500 };
const tfLimit = () => TF_LIMITS[activeTf] ?? 500;
// ② localStorage holds only tiny sync boot prefs; bulky data lives in IndexedDB.
const THEME_KEY  = 'wave-engine-theme'; // sync at boot to avoid theme flash
const LAST_TF_KEY = 'wave-last-tf';
const LAST_K_KEY  = 'wave-last-k';
const ANNOT_DB_KEY = 'annotations';       // IndexedDB kv key (was localStorage)
const LEGACY_SNAP_KEY = 'pred-snaps-v1';  // pre-① blob key (localStorage, then kv) — migrated away

const el      = (id) => document.getElementById(id);
const sym     = ()   => el('asset').value;
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

let waveChart;
// Boot on the last-used timeframe (validated), not a hardcoded 1D.
let activeTf = TIMEFRAMES.includes(localStorage.getItem(LAST_TF_KEY))
  ? localStorage.getItem(LAST_TF_KEY) : '1d';
let isDark   = (localStorage.getItem(THEME_KEY) ?? 'dark') === 'dark';
let annotMode  = false;
let annotPoints = [];
let cache = {};           // { [tf]: { candles, pivots, patterns, live, hyps } }
let selectedIdx    = null;
let selectedHypIdx = null;
let lastMetrics    = null;  // last computeMetrics result — refreshed each run()

// ── Pinned scenario (persists across refresh / asset / tf in localStorage) ─────
const PIN_KEY = 'pred-pin-v1';

// Stable signature of a hypothesis from its anchor pivots + stage, so a pinned
// scenario can be re-identified after the hypotheses are re-enumerated on
// refresh (the array index is NOT stable; the geometry is).
function hypSig(h) {
  const a = h?.anchor ?? {};
  return [a.O?.time, a.A?.time, a.B?.time ?? '', a.C?.time ?? '', h?.stage, h?.bias].join('|');
}

// ③ Pins are scoped per (série, TF): a map keyed by `${asset}|${tf}`, so a pin
// on 1h and a pin on 4h coexist and each is only drawn on its own view.
const pinKey = () => `${sym()}|${activeTf}`;

function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY));
    if (!raw || typeof raw !== 'object') return {};
    let map;
    // Soft-migrate an old single-pin object → keyed map (or purge if unusable).
    if (raw.sig || raw.paths || raw.ghostData) {
      map = (raw.asset && raw.tf && Array.isArray(raw.paths))
        ? { [`${raw.asset}|${raw.tf}`]: { paths: raw.paths, color: raw.color, sig: raw.sig, bias: raw.bias, stage: raw.stage } }
        : {}; // pre-④b format (ghostData) or unknown series → purge cleanly
    } else {
      map = raw; // already a map
    }
    // Keep only well-formed pins (paths = array of {candles[]}), so a corrupt
    // entry can never throw during render and freeze the chart.
    const clean = {};
    for (const [k, p] of Object.entries(map)) {
      if (p && Array.isArray(p.paths) && p.paths.every(pt => Array.isArray(pt?.candles))) clean[k] = p;
    }
    return clean;
  } catch { return {}; }
}
function savePins(map) {
  if (Object.keys(map).length) localStorage.setItem(PIN_KEY, JSON.stringify(map));
  else localStorage.removeItem(PIN_KEY);
}

// { [`${asset}|${tf}`]: { paths, color, sig, bias, stage } }
let pins = loadPins();

// The pin (if any) belonging to the current asset+tf view.
function currentPin() { return pins[pinKey()] ?? null; }
function pinMatchesView() { return !!currentPin(); }

// Largest candle time across a set of ghost paths (for panning the right edge).
function ghostMaxTime(paths) {
  let mx = 0;
  for (const p of paths ?? []) {
    const last = p.candles?.[p.candles.length - 1];
    if (last) mx = Math.max(mx, last.time);
  }
  return mx;
}

// Always reset the pinned overlay first so a stale pin from another series can
// never linger on the current chart; only redraw when it belongs to this view.
function redrawPinnedGhost() {
  if (!waveChart) return;
  waveChart.clearPinnedGhostCandles();
  const p = currentPin();
  if (!p?.paths?.length) return;
  try {
    waveChart.drawPinnedGhostPaths(p.paths, p.color);
    const mx = ghostMaxTime(p.paths);
    if (mx) waveChart.extendRightEdge(mx); // keep the pinned projection in view on return
  } catch {
    // A stale/corrupt pin must never break the chart — drop it.
    delete pins[pinKey()];
    savePins(pins);
    waveChart.clearPinnedGhostCandles();
  }
}

// Loading overlay over the chart — shown while fetching/analysing so a slow or
// stalled pass is never mistaken for a frozen app.
function setLoading(on, msg = 'Analyse…') {
  const o = el('chart-loading');
  if (!o) return;
  if (on) { const m = el('loading-msg'); if (m) m.textContent = msg; o.style.display = 'flex'; }
  else o.style.display = 'none';
}

// Prediction scenario colors (match chart.js DARK.scenario)
const PRED_COLORS = ['#00d4ff', '#b388ff', '#ffcc44', '#ff7744'];

// ④a — Minimum confidence to SHOW a prediction. Below this a hypothesis is
// noise (e.g. a typeless formingB at ~0.12) and is never rendered nor snapshotted.
// `let` so the ① optimiser can apply a swept value (kv 'applied-params').
let PRED_CONF_FLOOR = 0.15;

const STAGE_LABEL = {
  formingB:    'B EN COURS',
  formingC:    'C EN COURS',
  'awaiting2°': 'ATTEND. 2°',
};

// A flat's stored `bias` is its leg-A direction (the internal convention shared
// by predict.js / flats.js). The PREDICTED move — where the TP / 2° continuation
// sits — is the OPPOSITE: a "bull flat" (leg A up, in a down-trend) continues
// DOWN. We display this continuation direction so the card's arrow matches the
// chart's ghost candles and TP, instead of contradicting them.
function continuation(bias) {
  const down = bias === 'bull';
  return {
    arrow: down ? '▼' : '▲',
    label: down ? 'baissier' : 'haussier',
    cls:   down ? 'bear' : 'bull', // reuse existing red/green .pbias classes
  };
}

// ⑥ Image-mode ("schéma") state + continuation colour (green=up, red=down) used
// for the impulse strokes. continuation(bias).cls already maps to bull/bear.
let imageMode = false;
const CONT_HEX = { bull: '#00ff88', bear: '#ff3058' };
const contColor = (bias) => CONT_HEX[continuation(bias).cls];

// ── Snapshot persistence (structured IndexedDB store) ─────────────────────────
const SNAP_INTERVAL = 2 * 60 * 60 * 1000;  // 2h

// All snapshots, oldest-first. Records carry top-level asset/tf/paramHash for
// indexing + provenance (① attribution).
async function loadSnaps() {
  try { return (await snapGetAll()).sort((a, b) => a.timestamp - b.timestamp); }
  catch { return []; }
}

// ① Empirical leg-duration windows from resolved snapshots (per tf/type).
// Empty until enough 'hit' outcomes exist → timing falls back to Fibonacci.
async function loadTimingWindows() {
  try { return timingWindows(await snapGetAll()); }
  catch { return {}; }
}

// Coerce a legacy blob snapshot into a structured record (provenance back-filled).
function toRecord(s) {
  const asset  = s.asset ?? s.params?.asset ?? null;
  const tf     = s.tf    ?? s.params?.tf    ?? null;
  const params = buildParams({
    k:         s.params?.k ?? s.params?.sensitivity,
    minConf:   s.params?.minConf,
    predFloor: s.params?.predFloor,
  });
  return { ...s, asset, tf, paramHash: s.paramHash ?? hashParams(params) };
}

// One-time migration: pre-② localStorage blob and ②-era kv blob → structured
// store; legacy annotations localStorage → kv. Then drop the old keys.
async function migrateStorage() {
  // annotations: localStorage → kv (② path, for users who skipped it)
  const a = localStorage.getItem('wave-annotations');
  if (a != null) {
    try {
      const arr = JSON.parse(a);
      if (Array.isArray(arr) && arr.length && (await idbGet(ANNOT_DB_KEY)) == null) await idbSet(ANNOT_DB_KEY, arr);
    } catch { /* drop */ }
    localStorage.removeItem('wave-annotations');
  }
  // snapshots: localStorage blob OR kv blob → structured store (only if empty)
  let legacy = null;
  const ls = localStorage.getItem(LEGACY_SNAP_KEY);
  if (ls != null) { try { legacy = JSON.parse(ls); } catch {} localStorage.removeItem(LEGACY_SNAP_KEY); }
  if (!Array.isArray(legacy)) { try { legacy = await idbGet(LEGACY_SNAP_KEY); } catch {} }
  if (Array.isArray(legacy) && legacy.length) {
    try {
      const existing = await snapGetAll();
      if (!existing.length) await snapBulkPut(legacy.map(toRecord));
    } catch { /* best-effort */ }
  }
  try { await idbDel(LEGACY_SNAP_KEY); } catch {}
}

// Path-aware evaluation: walk the candles that printed since each snapshot, but
// only for snapshots captured on the currently-loaded series (same asset+tf).
// Re-persists only the records whose outcome actually changed.
async function autoEvaluate(candles, asset, tf) {
  const snaps = await loadSnaps();
  if (!snaps.length) return null;
  const updated = snaps.map(s => {
    const closed  = s.outcome != null && s.outcome !== 'pending';
    const matches = s.asset === asset && s.tf === tf;
    if (closed || !matches) return s;
    const next = evaluateSnapshotPath(s, candles); // spreads s → keeps asset/tf/paramHash/id
    return next;
  });
  for (let i = 0; i < updated.length; i++) {
    if (updated[i].outcome !== snaps[i].outcome) {
      try { await snapPut(updated[i]); } catch { /* best-effort */ }
    }
  }
  return computeMetrics(updated);
}

async function maybeCaptureSnap(hyps, livePrice) {
  if (!hyps?.length) return;
  const asset = sym(), tf = activeTf, now = Date.now();
  const snaps = await loadSnaps();
  // Throttle PER series (asset+tf), not globally.
  const lastForSeries = snaps.filter(s => s.asset === asset && s.tf === tf).pop();
  if (lastForSeries && now - lastForSeries.timestamp < SNAP_INTERVAL) return;

  const params    = buildParams({ k: +el('sensitivity').value, minConf: +el('min-conf').value, predFloor: PRED_CONF_FLOOR });
  const paramHash = hashParams(params);
  const snap = takeSnapshot(hyps, livePrice, {
    timestamp: now,
    id:        `${asset}_${tf}_${now}`,
    params:    { ...params, asset, tf },
  });
  // Top-level indexed/provenance fields.
  snap.asset = asset; snap.tf = tf; snap.paramHash = paramHash;
  try { await snapPut(snap); } catch { /* best-effort */ }
}

function buildMetricsStr(metrics) {
  if (!metrics || metrics.total === 0) return 'En attente du 1er snapshot (2h)';
  const accStr = metrics.accuracy != null
    ? ` · ${(metrics.accuracy * 100).toFixed(0)}% acc`
    : '';
  const expStr = metrics.expired ? ` · ⌛ ${metrics.expired}` : '';
  return `${metrics.total} snap · ✓ ${metrics.hit} · ✗ ${metrics.miss} · ⏳ ${metrics.pending}${expStr}${accStr}`;
}

// ── Thème ────────────────────────────────────────────────────────────────────

function applyTheme() {
  document.body.classList.toggle('light', !isDark);
  el('theme-toggle').textContent = isDark ? '☀' : '🌙';
  if (waveChart) waveChart.setTheme(isDark);
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
}
applyTheme();

// ── Fetch + détection ────────────────────────────────────────────────────────

let runSeq = 0;  // guards against overlapping runs (rapid tab/asset switches)

async function run() {
  const mySeq = ++runSeq;
  const sensitivity = +el('sensitivity').value;
  setStatus(`Chargement ${sym()} ${activeTf}…`);
  setLoading(true, `Chargement ${sym()} ${activeTf}…`);

  try {
    let candles;
    try {
      candles = await fetchKlines(sym(), activeTf, tfLimit());
    } catch (e) {
      setStatus(`Erreur réseau: ${e.message} — réessayer avec ↻`, true);
      return; // finally still hides the spinner
    }
    if (mySeq !== runSeq) return; // a newer run started; abandon this one

    setLoading(true, `Analyse ${sym()} ${activeTf}…`);
    el('price').textContent = '$' + candles[candles.length - 1].close.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const pivots   = zigzag(candles, { atrMult: sensitivity, atrPeriod: 14 });
    const confirmed = pivots.filter(p => !p.tentative);
    const minConf   = +el('min-conf').value;
    const patterns  = detectFlatPatterns(confirmed, { minConfidence: minConf, maxLegSpan: 3, candles });
    const live      = detectLiveFlat(pivots, { minConfidence: minConf * 0.7 });

    // Predictive engine: enumerate hypotheses from confirmed pivots
    const livePrice  = candles[candles.length - 1].close;
    const currentBar = candles.length - 1;
    const timingWins = await loadTimingWindows();  // ① empirical durations (Fibonacci fallback)
    let hyps = enumerateHypotheses(confirmed, livePrice);
    hyps = withTiming(hyps, currentBar, { windows: timingWins, tf: activeTf });
    hyps = rankAndBeam(hyps, 4);
    hyps = hyps.filter(h => h.confidence.value >= PRED_CONF_FLOOR);  // ④a confidence floor

    lastMetrics = await autoEvaluate(candles, sym(), activeTf);
    await maybeCaptureSnap(hyps, livePrice);
    if (mySeq !== runSeq) return;

    cache[activeTf] = { candles, pivots, patterns, live, hyps };

    if (!waveChart) waveChart = createWaveChart(el('chart'), isDark);
    waveChart.setCandles(candles);
    waveChart.setZigzag(pivots);
    waveChart.clearFlatPatterns();
    waveChart.clearPredictions();
    waveChart.clearImage();
    waveChart.drawFlatPatterns(patterns);
    if (live) waveChart.drawLiveFlat(live);
    waveChart.fit();
    redrawPinnedGhost();

    selectedIdx    = null;
    selectedHypIdx = null;
    renderTabs();
    renderPatternList(patterns, live, hyps);
    setStatus(`${patterns.length} patterns · ${sym()} ${activeTf} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`Erreur: ${e.message}`, true);
    console.error('run() failed:', e);
  } finally {
    if (mySeq === runSeq) setLoading(false);
  }
}

// ── Onglets TF ───────────────────────────────────────────────────────────────

function renderTabs() {
  const wrap = el('tabs');
  wrap.innerHTML = TIMEFRAMES.map(tf =>
    `<button class="tab ${tf === activeTf ? 'active' : ''}" data-tf="${tf}">${tf}</button>`
  ).join('');
  wrap.querySelectorAll('.tab').forEach(b =>
    b.addEventListener('click', () => {
      activeTf = b.dataset.tf;
      localStorage.setItem(LAST_TF_KEY, activeTf);  // ② remember last timeframe
      if (annotMode) exitAnnotMode();
      run();
    })
  );
}

// ── Selection rendering (normal vs ⑥ image mode) ──────────────────────────────

// Draw a predictive hypothesis: image grammar if imageMode, else drawPrediction
// + ghost candles. Sets the selection state.
function showPredictionSelection(i) {
  const data = cache[activeTf];
  const hyp  = data?.hyps?.[i];
  if (!hyp) return;
  selectedHypIdx = i;
  selectedIdx    = null;
  waveChart.clearImage();
  if (imageMode) {
    waveChart.clearFlatPatterns();
    waveChart.clearPredictions();
    waveChart.clearGhostCandles();
    waveChart.drawImage(hypImageSpec(hyp), contColor(hyp.bias));
  } else {
    waveChart.clearFlatPatterns();
    waveChart.drawFlatPatterns(data.patterns);
    if (data.live) waveChart.drawLiveFlat(data.live);
    const color = PRED_COLORS[i % PRED_COLORS.length];
    waveChart.drawPrediction(hyp, color);
    const lp    = data.candles[data.candles.length - 1].close;
    const paths = generateGhostPaths(hyp, lp, data.candles);
    waveChart.drawGhostPaths(paths, color);
    const mx = ghostMaxTime(paths);
    if (mx) waveChart.extendRightEdge(mx);
  }
  redrawPinnedGhost();
}

// Draw a historical flat: image grammar if imageMode, else highlightFlat.
function showHistoricalSelection(idx) {
  const data = cache[activeTf];
  const p    = data?.patterns?.[idx];
  if (!p) return;
  selectedIdx    = idx;
  selectedHypIdx = null;
  waveChart.clearPredictions();
  waveChart.clearGhostCandles();
  waveChart.clearImage();
  if (imageMode) {
    waveChart.clearFlatPatterns(); // hide candle-by-candle flat overlays
    waveChart.drawImage(patternImageSpec(p, data.pivots.filter(x => !x.tentative)), contColor(p.bias));
  } else {
    waveChart.highlightFlat(data.patterns, idx);
  }
  redrawPinnedGhost();
}

// Deselect everything → restore the base flat overlays.
function clearSelection() {
  selectedIdx    = null;
  selectedHypIdx = null;
  const data = cache[activeTf];
  waveChart.clearPredictions();
  waveChart.clearGhostCandles();
  waveChart.clearImage();
  waveChart.clearFlatPatterns();
  if (data) {
    waveChart.drawFlatPatterns(data.patterns);
    if (data.live) waveChart.drawLiveFlat(data.live);
  }
  redrawPinnedGhost();
}

// Re-render whatever is selected (used when toggling image mode).
function redrawSelection() {
  if (selectedHypIdx != null)      showPredictionSelection(selectedHypIdx);
  else if (selectedIdx != null)    showHistoricalSelection(selectedIdx);
  else                             waveChart.clearImage();
}

// ── Liste des patterns (panneau droit) ───────────────────────────────────────

function renderPatternList(patterns, live, hyps = []) {
  const wrap = el('pattern-list');
  let html = '';

  // ── EN COURS (live flat detection) ──────────────────────────────────────────
  if (live) {
    const types = live.possibleTypes.map(t => FLAT_LABELS[t]).join(' / ');
    const col   = FLAT_COLORS[live.possibleTypes[0]] ?? '#aaa';
    const cont  = continuation(live.bias);
    html += `
      <div class="pcard live" style="--accent:${col}">
        <div class="pcard-head">
          <span class="live-badge">EN COURS</span>
          <span class="pname">${types}</span>
          <span class="pbias ${cont.cls}" title="Sens de continuation prévu">${cont.arrow} ${cont.label}</span>
        </div>
        <div class="prow"><span class="pk">B/A</span><span class="pv">${live.bRet}</span></div>
        <div class="prow"><span class="pk">Depuis</span><span class="pv">${fmtDate(live.aStart.time)}</span></div>
      </div>`;
  }

  // ── PRÉDICTIONS (predictive engine output) ───────────────────────────────────
  html += '<div class="section-label">PRÉDICTIONS</div>';
  if (!hyps?.length) {
    html += '<p class="muted" style="padding:1rem .8rem">Pas de scénario fiable '
          + `(confiance &lt; ${(PRED_CONF_FLOOR * 100).toFixed(0)}%).</p>`;
  } else {
    hyps.forEach((h, i) => {
      const col      = PRED_COLORS[i % PRED_COLORS.length];
      const cont     = continuation(h.bias);
      const conf     = (h.confidence.value * 100).toFixed(0);
      const stLbl    = STAGE_LABEL[h.stage] ?? h.stage;
      const branch   = h.typeBranch?.join(' · ') ?? '—';
      const sel      = selectedHypIdx === i;
      const isPinned = currentPin()?.sig === hypSig(h);

      let targetLine = '';
      const soft = h.zones?.invalidation?.soft;
      const tp   = h.zones?.tp;
      if (h.stage === 'awaiting2°' && tp) {
        const tgt = h.bias === 'bull' ? tp[0] : tp[1];
        targetLine = `<div class="prow"><span class="pk">TP</span><span class="pv">$${Math.round(tgt).toLocaleString()}</span></div>`;
      } else if (soft) {
        const [lo, hi] = soft;
        targetLine = `<div class="prow"><span class="pk">Zone</span><span class="pv">$${Math.round(lo).toLocaleString()} – $${Math.round(hi).toLocaleString()}</span></div>`;
      }

      html += `
        <div class="pcard pred${sel ? ' selected' : ''}${isPinned ? ' pinned' : ''}" style="--accent:${col}" data-hyp="${i}">
          <div class="pcard-head">
            <span class="live-badge" style="background:${col}22;color:${col}">${stLbl}</span>
            <span class="pbias ${cont.cls}" title="Sens de continuation prévu (cible / 2°)">${cont.arrow} ${cont.label}</span>
            <button class="pin-btn${isPinned ? ' on' : ''}" data-pin="${i}" title="${isPinned ? 'Défixer' : 'Fixer l\'estimation'}">📌</button>
          </div>
          <div class="prow"><span class="pk">Type</span><span class="pv">${branch}</span></div>
          <div class="prob-bar"><i style="width:${conf}%;background:${col}"></i></div>
          <div class="prow"><span class="pk">Conf</span><span class="pv">${conf}%</span></div>
          ${targetLine}
        </div>`;
    });
    html += `<div class="pred-metrics">${buildMetricsStr(lastMetrics)}</div>`;
  }

  // Fallback unpin: a pin is active on this series but its hypothesis is no
  // longer among the shown beam (it dropped out on a refresh) — give the user
  // a guaranteed way to remove it.
  const cp = currentPin();
  if (cp && !hyps.some(h => hypSig(h) === cp.sig)) {
    const cont = continuation(cp.bias);
    html += `<div class="pin-orphan">📌 épingle active (${cont.label})
      <button id="pin-clear">retirer</button></div>`;
  }

  // ── HISTORIQUE ────────────────────────────────────────────────────────────────
  if (patterns.length || hyps?.length) {
    html += '<div class="section-label">HISTORIQUE</div>';
  }
  if (!patterns.length) {
    html += '<p class="muted" style="padding:1rem .8rem">Aucun pattern — essayer une sensibilité plus basse.</p>';
  } else {
    [...patterns].reverse().forEach((p, revI) => {
      const origIdx = patterns.length - 1 - revI;
      const col   = FLAT_COLORS[p.type] ?? '#888';
      const cont  = continuation(p.bias);
      const sel   = selectedIdx === origIdx;
      html += `
        <div class="pcard${sel ? ' selected' : ''}" style="--accent:${col}" data-idx="${origIdx}">
          <div class="pcard-head">
            <span class="pname">${p.label}</span>
            <span class="pbias ${cont.cls}" title="Sens de continuation">${cont.arrow} ${cont.label}</span>
          </div>
          <div class="prob-bar"><i style="width:${((p.confidence ?? 0) * 100).toFixed(0)}%;background:${col}"></i></div>
          <div class="prow"><span class="pk">Conf</span><span class="pv">${((p.confidence ?? 0) * 100).toFixed(0)}%</span></div>
          <div class="prow"><span class="pk">B/A · C/A</span><span class="pv">${p.bRet} · ${p.cRet}</span></div>
          <div class="prow"><span class="pk">Période</span><span class="pv">${fmtDate(p.aStart.time)} → ${fmtDate(p.cEnd.time)}</span></div>
        </div>`;
    });
  }

  wrap.innerHTML = html;

  // Fallback unpin handler
  const pinClear = el('pin-clear');
  if (pinClear) pinClear.addEventListener('click', () => {
    delete pins[pinKey()];
    savePins(pins);
    waveChart.clearPinnedGhostCandles();
    renderPatternList(patterns, live, hyps);
  });

  // Click: predictive hypothesis card
  wrap.querySelectorAll('.pcard[data-hyp]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('pin-btn')) return;
      const data = cache[activeTf];
      if (!data) return;
      const i   = +card.dataset.hyp;
      if (!data.hyps?.[i]) return;

      if (selectedHypIdx === i) clearSelection();
      else                      showPredictionSelection(i);
      renderPatternList(data.patterns, data.live, data.hyps);
    });
  });

  // Click: pin button (freeze ghost candles across refreshes)
  wrap.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const data = cache[activeTf];
      if (!data) return;
      const i     = +btn.dataset.pin;
      const hyp   = data.hyps?.[i];
      if (!hyp) return;
      const color = PRED_COLORS[i % PRED_COLORS.length];
      const sig   = hypSig(hyp);

      const key = pinKey();
      if (pins[key]?.sig === sig) {
        delete pins[key];
        savePins(pins);
        waveChart.clearPinnedGhostCandles();
      } else {
        const lp    = data.candles[data.candles.length - 1].close;
        const paths = generateGhostPaths(hyp, lp, data.candles);
        pins[key]   = { paths, color, sig, bias: hyp.bias, stage: hyp.stage };
        savePins(pins);
        waveChart.drawPinnedGhostPaths(paths, color);
        const mx = ghostMaxTime(paths);
        if (mx) waveChart.extendRightEdge(mx);
      }
      renderPatternList(data.patterns, data.live, data.hyps);
    });
  });

  // Click: historical pattern card
  wrap.querySelectorAll('.pcard[data-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const data = cache[activeTf];
      if (!data) return;
      const idx = +card.dataset.idx;
      if (selectedIdx === idx) clearSelection();
      else                     showHistoricalSelection(idx);
      renderPatternList(data.patterns, data.live, data.hyps);
    });
  });
}

// ── Annotation manuelle ───────────────────────────────────────────────────────

async function loadAnnotations() {
  try { return (await idbGet(ANNOT_DB_KEY)) ?? []; }
  catch { return []; }
}

async function saveAnnotations(list) {
  try { await idbSet(ANNOT_DB_KEY, list); }
  catch { /* best-effort */ }
}

function classifyFromPoints(pts) {
  const aLen = Math.abs(pts[1].price - pts[0].price);
  if (aLen === 0) return { type: 'regular', bias: 'bull', bRet: 0 };
  const bLen = Math.abs(pts[2].price - pts[1].price);
  const bRet = bLen / aLen;
  const aDir = Math.sign(pts[1].price - pts[0].price);
  const bBreaksAStart = aDir < 0 ? pts[2].price > pts[0].price : pts[2].price < pts[0].price;
  // leg-A convention (matches flats.js / predict.js): legA>0 → bull, legA<0 → bear.
  // (Was inverted here, so the annotation tool labelled patterns opposite to the
  // detector.) Cards display the continuation direction via continuation().
  const bias = aDir > 0 ? 'bull' : 'bear';

  let type;
  if (bBreaksAStart)    type = bRet >= 1.5 ? 'expanding' : 'running';
  else if (bRet >= 0.65) type = 'regular';
  else                   type = 'contracting';

  return { type, bias, bRet: +bRet.toFixed(3) };
}

function enterAnnotMode() {
  annotMode = true;
  annotPoints = [];
  el('annot-mode').textContent = '✕ ANNULER';
  el('annot-mode').classList.add('on');
  el('annot-bar').style.display = 'flex';
  el('annot-step').textContent = 'Cliquer le début de A';
  el('annot-confirm').style.display = 'none';
  el('annot-type').style.display = 'none';
  el('annot-type-info').textContent = '';
  waveChart.clearSimilarMatches();
  waveChart.subscribeClick(handleAnnotClick);
}

function exitAnnotMode() {
  annotMode = false;
  annotPoints = [];
  el('annot-mode').textContent = '✏ ANNOTER';
  el('annot-mode').classList.remove('on');
  el('annot-bar').style.display = 'none';
  if (waveChart) {
    waveChart.unsubscribeClick();
    waveChart.clearAnnotPoints();
  }
}

function handleAnnotClick(time, price) {
  annotPoints.push({ time, price });
  waveChart.drawAnnotPoints(annotPoints);

  if (annotPoints.length === 1) {
    el('annot-step').textContent = 'Cliquer la fin de A (= début de B)';
  } else if (annotPoints.length === 2) {
    el('annot-step').textContent = 'Cliquer la fin de B (= début de C)';
  } else if (annotPoints.length === 3) {
    const { type, bias, bRet } = classifyFromPoints(annotPoints);
    const cont = continuation(bias);
    el('annot-step').textContent = 'Détecté :';
    el('annot-type-info').textContent = `${cont.arrow} ${cont.label} · B/A = ${bRet}`;
    el('annot-type').value = type;
    el('annot-type').style.display = '';
    el('annot-confirm').style.display = '';
    waveChart.unsubscribeClick();
  }
}

async function confirmAnnotation() {
  const type = el('annot-type').value;
  const { bias, bRet } = classifyFromPoints(annotPoints);
  const annotation = {
    id: Date.now().toString(),
    asset: sym(), timeframe: activeTf, type, bias, bRet,
    pivots: [
      { role: 'aStart', ...annotPoints[0] },
      { role: 'aEnd',   ...annotPoints[1] },
      { role: 'bEnd',   ...annotPoints[2] },
    ],
    createdAt: Date.now(),
  };
  const list = await loadAnnotations();
  list.push(annotation);
  await saveAnnotations(list);

  const data = cache[activeTf];
  const matches = data?.pivots ? findSimilarPatterns(annotation, data.pivots.filter(p => !p.tentative)) : [];
  exitAnnotMode();
  if (matches.length) {
    waveChart.drawSimilarMatches(matches);
    setStatus(`✓ Annotation sauvée · ${matches.length} patterns similaires trouvés`);
  } else {
    setStatus('✓ Annotation sauvée · aucun match (essayer autre TF ou sensibilité)');
  }
}

function findSimilarPatterns(example, pivots, threshold = 0.45) {
  const exBias    = example.bias;
  const exBret    = example.bRet;
  const [exA, exAEnd, exBEnd] = example.pivots;
  const exDurRatio = (exBEnd.time - exAEnd.time) / Math.max(1, exAEnd.time - exA.time);

  const out = [];
  for (let i = 0; i + 2 < pivots.length; i++) {
    const aStart = pivots[i], aEnd = pivots[i + 1], bEnd = pivots[i + 2];
    if (aStart.type !== bEnd.type) continue;

    const aLen = Math.abs(aEnd.price - aStart.price);
    if (aLen === 0) continue;
    const bRet  = Math.abs(bEnd.price - aEnd.price) / aLen;
    const bias  = (aEnd.price > aStart.price) ? 'bull' : 'bear'; // leg-A convention (matches flats.js)
    if (bias !== exBias) continue;

    const ratioDiff  = Math.abs(bRet - exBret) / Math.max(0.1, exBret);
    const ratioScore = Math.max(0, 1 - ratioDiff * 2);
    const durRatio   = (bEnd.time - aEnd.time) / Math.max(1, aEnd.time - aStart.time);
    const durDiff    = Math.abs(durRatio - exDurRatio) / Math.max(0.1, exDurRatio);
    const durScore   = Math.max(0, 1 - durDiff);

    const score = 0.65 * ratioScore + 0.35 * durScore;
    if (score >= threshold) out.push({ aStart, aEnd, bEnd, similarity: score, type: example.type, bias });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, 20);
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const s = el('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

// ── Event listeners ───────────────────────────────────────────────────────────

el('theme-toggle').addEventListener('click', () => { isDark = !isDark; applyTheme(); });
el('asset').addEventListener('change', () => { cache = {}; selectedIdx = null; if (annotMode) exitAnnotMode(); run(); });
el('sensitivity').addEventListener('change', () => {
  localStorage.setItem(LAST_K_KEY, el('sensitivity').value);  // ② remember last K
  cache = {}; run();
});
el('min-conf').addEventListener('change', () => { cache = {}; run(); });
el('refresh').addEventListener('click', () => { cache = {}; run(); });
el('image-mode').addEventListener('click', () => {
  imageMode = !imageMode;
  el('image-mode').classList.toggle('on', imageMode);
  redrawSelection();  // redraw the current selection in the new mode (or clear image)
});
el('annot-mode').addEventListener('click', () => { if (annotMode) exitAnnotMode(); else enterAnnotMode(); });
el('annot-confirm').addEventListener('click', confirmAnnotation);
el('annot-cancel').addEventListener('click', exitAnnotMode);

// ── Boot ───────────────────────────────────────────────────────────────────────
// Restore last K (sensitivity), migrate any pre-② localStorage data to IndexedDB,
// then run on the restored timeframe.
const savedK = localStorage.getItem(LAST_K_KEY);
if (savedK != null && el('sensitivity')) el('sensitivity').value = savedK;

// Apply any params accepted from the ① optimiser (snapshots page → kv). Sets the
// sensitivity input (k) and the prediction floor; the user sees k change (no
// hidden override) and can still tune it manually afterward.
async function applyStoredParams() {
  let ap = null;
  try { ap = await idbGet('applied-params'); } catch { /* none */ }
  if (!ap) return;
  if (ap.k != null && el('sensitivity')) {
    el('sensitivity').value = ap.k;
    localStorage.setItem(LAST_K_KEY, String(ap.k));
  }
  if (Number.isFinite(ap.predFloor)) PRED_CONF_FLOOR = ap.predFloor;
}

// Cap any awaited boot step so a stalled/blocked IndexedDB can never freeze the
// first paint (the step still completes in the background; data is picked up on
// the next run).
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p).catch(() => {}),
  new Promise(res => setTimeout(res, ms)),
]);

(async () => {
  await withTimeout(migrateStorage(), 3000);   // normally <100ms; bounded if blocked
  await withTimeout(applyStoredParams(), 1500);
  run();                                         // always reached
})();
