import { fetchKlines } from '../core/data.js';
import { zigzag } from '../core/zigzag.js';
import { createWaveChart } from './chart.js';
import { detectFlatPatterns, detectLiveFlat, FLAT_COLORS, FLAT_LABELS } from '../core/flats.js';
import { enumerateHypotheses, rankAndBeam } from '../core/predict.js';
import { withTiming } from '../core/timing.js';
import { takeSnapshot, evaluateSnapshot, computeMetrics } from '../core/snapshot.js';
import { generateGhostCandles } from '../core/ghost.js';

const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'];
const TF_LIMIT   = 500;
const THEME_KEY  = 'wave-engine-theme';
const ANNOT_KEY  = 'wave-annotations';

const el      = (id) => document.getElementById(id);
const sym     = ()   => el('asset').value;
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

let waveChart;
let activeTf = '1d';
let isDark   = (localStorage.getItem(THEME_KEY) ?? 'dark') === 'dark';
let annotMode  = false;
let annotPoints = [];
let cache = {};           // { [tf]: { candles, pivots, patterns, live, hyps } }
let selectedIdx    = null;
let selectedHypIdx = null;
let pinnedHyp      = null;  // { ghostData:{candles,pivots}, color, hypIdx, tf } | null
let lastMetrics    = null;  // last computeMetrics result — refreshed each run()

function redrawPinnedGhost() {
  if (!pinnedHyp || !waveChart) return;
  waveChart.drawGhostCandles(pinnedHyp.ghostData.candles, pinnedHyp.ghostData.pivots, pinnedHyp.color + '88');
}

// Prediction scenario colors (match chart.js DARK.scenario)
const PRED_COLORS = ['#00d4ff', '#b388ff', '#ffcc44', '#ff7744'];

const STAGE_LABEL = {
  formingB:    'B EN COURS',
  formingC:    'C EN COURS',
  'awaiting2°': 'ATTEND. 2°',
};

// ── Snapshot persistence ──────────────────────────────────────────────────────
const SNAP_KEY      = 'pred-snaps-v1';
const SNAP_INTERVAL = 2 * 60 * 60 * 1000;  // 2h
const MAX_SNAPS     = 60;

function loadSnaps() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) ?? '[]'); }
  catch { return []; }
}

function saveSnaps(list) {
  localStorage.setItem(SNAP_KEY, JSON.stringify(list.slice(-MAX_SNAPS)));
}

function autoEvaluate(currentPrice) {
  const snaps = loadSnaps();
  if (!snaps.length) return null;
  const updated = snaps.map(s =>
    (s.outcome != null && s.outcome !== 'pending') ? s : evaluateSnapshot(s, currentPrice)
  );
  saveSnaps(updated);
  return computeMetrics(updated);
}

function maybyCaptureSnap(hyps, livePrice) {
  if (!hyps?.length) return;
  const snaps = loadSnaps();
  const now   = Date.now();
  const last  = snaps[snaps.length - 1];
  if (last && now - last.timestamp < SNAP_INTERVAL) return;
  snaps.push(takeSnapshot(hyps, livePrice, {
    timestamp: now,
    id:        `${sym()}_${activeTf}_${now}`,
    params:    { sensitivity: +el('sensitivity').value, minConf: +el('min-conf').value, asset: sym(), tf: activeTf },
  }));
  saveSnaps(snaps);
}

function buildMetricsStr(metrics) {
  if (!metrics || metrics.total === 0) return 'En attente du 1er snapshot (2h)';
  const accStr = metrics.accuracy != null
    ? ` · ${(metrics.accuracy * 100).toFixed(0)}% acc`
    : '';
  return `${metrics.total} snap · ✓ ${metrics.hit} · ✗ ${metrics.miss} · ⏳ ${metrics.pending}${accStr}`;
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

async function run() {
  const sensitivity = +el('sensitivity').value;
  setStatus(`Chargement ${sym()} ${activeTf}…`);

  let candles;
  try {
    candles = await fetchKlines(sym(), activeTf, TF_LIMIT);
  } catch (e) {
    setStatus(`Erreur réseau: ${e.message}`, true);
    return;
  }

  el('price').textContent = '$' + candles[candles.length - 1].close.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pivots   = zigzag(candles, { atrMult: sensitivity, atrPeriod: 14 });
  const confirmed = pivots.filter(p => !p.tentative);
  const minConf   = +el('min-conf').value;
  const patterns  = detectFlatPatterns(confirmed, { minConfidence: minConf, maxLegSpan: 3, candles });
  const live      = detectLiveFlat(pivots, { minConfidence: minConf * 0.7 });

  // Predictive engine: enumerate hypotheses from confirmed pivots
  const livePrice  = candles[candles.length - 1].close;
  const currentBar = candles.length - 1;
  let hyps = enumerateHypotheses(confirmed, livePrice);
  hyps = withTiming(hyps, currentBar);
  hyps = rankAndBeam(hyps, 4);

  lastMetrics = autoEvaluate(livePrice);
  maybyCaptureSnap(hyps, livePrice);

  cache[activeTf] = { candles, pivots, patterns, live, hyps };

  if (!waveChart) waveChart = createWaveChart(el('chart'), isDark);
  waveChart.setCandles(candles);
  waveChart.setZigzag(pivots);
  waveChart.clearFlatPatterns();
  waveChart.clearPredictions();
  waveChart.drawFlatPatterns(patterns);
  if (live) waveChart.drawLiveFlat(live);
  waveChart.fit();
  redrawPinnedGhost();

  selectedIdx    = null;
  selectedHypIdx = null;
  renderTabs();
  renderPatternList(patterns, live, hyps);
  setStatus(`${patterns.length} patterns · ${sym()} ${activeTf} · ${new Date().toLocaleTimeString()}`);
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
      if (annotMode) exitAnnotMode();
      run();
    })
  );
}

// ── Liste des patterns (panneau droit) ───────────────────────────────────────

function renderPatternList(patterns, live, hyps = []) {
  const wrap = el('pattern-list');
  let html = '';

  // ── EN COURS (live flat detection) ──────────────────────────────────────────
  if (live) {
    const types = live.possibleTypes.map(t => FLAT_LABELS[t]).join(' / ');
    const col   = FLAT_COLORS[live.possibleTypes[0]] ?? '#aaa';
    const arrow = live.bias === 'bull' ? '▲' : '▼';
    html += `
      <div class="pcard live" style="--accent:${col}">
        <div class="pcard-head">
          <span class="live-badge">EN COURS</span>
          <span class="pname">${types}</span>
          <span class="pbias ${live.bias}">${arrow} ${live.bias}</span>
        </div>
        <div class="prow"><span class="pk">B/A</span><span class="pv">${live.bRet}</span></div>
        <div class="prow"><span class="pk">Depuis</span><span class="pv">${fmtDate(live.aStart.time)}</span></div>
      </div>`;
  }

  // ── PRÉDICTIONS (predictive engine output) ───────────────────────────────────
  if (hyps?.length) {
    html += '<div class="section-label">PRÉDICTIONS</div>';
    hyps.forEach((h, i) => {
      const col      = PRED_COLORS[i % PRED_COLORS.length];
      const arrow    = h.bias === 'bull' ? '▲' : '▼';
      const conf     = (h.confidence.value * 100).toFixed(0);
      const stLbl    = STAGE_LABEL[h.stage] ?? h.stage;
      const branch   = h.typeBranch?.join(' · ') ?? '—';
      const sel      = selectedHypIdx === i;
      const isPinned = pinnedHyp?.hypIdx === i && pinnedHyp?.tf === activeTf;

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
            <span class="pbias ${h.bias}">${arrow} ${h.bias}</span>
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
      const arrow = p.bias === 'bull' ? '▲' : '▼';
      const sel   = selectedIdx === origIdx;
      html += `
        <div class="pcard${sel ? ' selected' : ''}" style="--accent:${col}" data-idx="${origIdx}">
          <div class="pcard-head">
            <span class="pname">${p.label}</span>
            <span class="pbias ${p.bias}">${arrow} ${p.bias}</span>
          </div>
          <div class="prob-bar"><i style="width:${((p.confidence ?? 0) * 100).toFixed(0)}%;background:${col}"></i></div>
          <div class="prow"><span class="pk">Conf</span><span class="pv">${((p.confidence ?? 0) * 100).toFixed(0)}%</span></div>
          <div class="prow"><span class="pk">B/A · C/A</span><span class="pv">${p.bRet} · ${p.cRet}</span></div>
          <div class="prow"><span class="pk">Période</span><span class="pv">${fmtDate(p.aStart.time)} → ${fmtDate(p.cEnd.time)}</span></div>
        </div>`;
    });
  }

  wrap.innerHTML = html;

  // Click: predictive hypothesis card
  wrap.querySelectorAll('.pcard[data-hyp]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('pin-btn')) return;
      const data = cache[activeTf];
      if (!data) return;
      const i   = +card.dataset.hyp;
      const hyp = data.hyps?.[i];
      if (!hyp) return;

      if (selectedHypIdx === i) {
        selectedHypIdx = null;
        waveChart.clearPredictions();
        redrawPinnedGhost();
      } else {
        selectedHypIdx = i;
        selectedIdx    = null;
        waveChart.clearFlatPatterns();
        waveChart.drawFlatPatterns(data.patterns);
        if (data.live) waveChart.drawLiveFlat(data.live);
        const color = PRED_COLORS[i % PRED_COLORS.length];
        waveChart.drawPrediction(hyp, color);
        const lp    = data.candles[data.candles.length - 1].close;
        const ghost = generateGhostCandles(hyp, lp, data.candles);
        waveChart.drawGhostCandles(ghost.candles, ghost.pivots, color);
        if (ghost.candles.length) waveChart.extendRightEdge(ghost.candles[ghost.candles.length - 1].time);
      }
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

      if (pinnedHyp?.hypIdx === i && pinnedHyp?.tf === activeTf) {
        pinnedHyp = null;
        waveChart.clearGhostCandles();
      } else {
        const lp        = data.candles[data.candles.length - 1].close;
        const ghostData = generateGhostCandles(hyp, lp, data.candles);
        pinnedHyp = { ghostData, color, hypIdx: i, tf: activeTf };
        waveChart.drawGhostCandles(ghostData.candles, ghostData.pivots, color + '88');
        if (ghostData.candles.length) waveChart.extendRightEdge(ghostData.candles[ghostData.candles.length - 1].time);
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
      if (selectedIdx === idx) {
        selectedIdx = null;
        waveChart.clearFlatPatterns();
        waveChart.drawFlatPatterns(data.patterns);
        if (data.live) waveChart.drawLiveFlat(data.live);
        redrawPinnedGhost();
      } else {
        selectedIdx    = idx;
        selectedHypIdx = null;
        waveChart.clearPredictions();
        waveChart.highlightFlat(data.patterns, idx);
        redrawPinnedGhost();
      }
      renderPatternList(data.patterns, data.live, data.hyps);
    });
  });
}

// ── Annotation manuelle ───────────────────────────────────────────────────────

function loadAnnotations() {
  try { return JSON.parse(localStorage.getItem(ANNOT_KEY) || '[]'); }
  catch { return []; }
}

function saveAnnotations(list) {
  localStorage.setItem(ANNOT_KEY, JSON.stringify(list));
}

function classifyFromPoints(pts) {
  const aLen = Math.abs(pts[1].price - pts[0].price);
  if (aLen === 0) return { type: 'regular', bias: 'bull', bRet: 0 };
  const bLen = Math.abs(pts[2].price - pts[1].price);
  const bRet = bLen / aLen;
  const aDir = Math.sign(pts[1].price - pts[0].price);
  const bBreaksAStart = aDir < 0 ? pts[2].price > pts[0].price : pts[2].price < pts[0].price;
  const bias = aDir < 0 ? 'bull' : 'bear';

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
    el('annot-step').textContent = 'Détecté :';
    el('annot-type-info').textContent = `${bias === 'bull' ? '▲' : '▼'} ${bias} · B/A = ${bRet}`;
    el('annot-type').value = type;
    el('annot-type').style.display = '';
    el('annot-confirm').style.display = '';
    waveChart.unsubscribeClick();
  }
}

function confirmAnnotation() {
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
  const list = loadAnnotations();
  list.push(annotation);
  saveAnnotations(list);

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
    const bias  = (aEnd.price < aStart.price) ? 'bull' : 'bear'; // aDir sign
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
el('sensitivity').addEventListener('change', () => { cache = {}; run(); });
el('min-conf').addEventListener('change', () => { cache = {}; run(); });
el('refresh').addEventListener('click', () => { cache = {}; run(); });
el('annot-mode').addEventListener('click', () => { if (annotMode) exitAnnotMode(); else enterAnnotMode(); });
el('annot-confirm').addEventListener('click', confirmAnnotation);
el('annot-cancel').addEventListener('click', exitAnnotMode);

run();
