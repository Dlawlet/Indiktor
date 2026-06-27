import { fetchKlines } from '../core/data.js';
import { zigzag } from '../core/zigzag.js';
import { createWaveChart } from './chart.js';
import { detectFlatPatterns, detectLiveFlat, FLAT_COLORS, FLAT_LABELS } from '../core/flats.js';

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
let cache = {};           // { [tf]: { candles, pivots, patterns, live } }
let selectedIdx = null;

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

  cache[activeTf] = { candles, pivots, patterns, live };

  if (!waveChart) waveChart = createWaveChart(el('chart'), isDark);
  waveChart.setCandles(candles);
  waveChart.setZigzag(pivots);
  waveChart.clearFlatPatterns();
  waveChart.drawFlatPatterns(patterns);
  if (live) waveChart.drawLiveFlat(live);
  waveChart.fit();

  selectedIdx = null;
  renderTabs();
  renderPatternList(patterns, live);
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

function renderPatternList(patterns, live) {
  const wrap = el('pattern-list');
  let html = '';

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

  if (!patterns.length) {
    html += '<p class="muted" style="padding:1rem .8rem">Aucun pattern détecté — essayer une sensibilité plus basse.</p>';
  } else {
    // Most recent first
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
      } else {
        selectedIdx = idx;
        waveChart.highlightFlat(data.patterns, idx);
      }
      renderPatternList(data.patterns, data.live);
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
