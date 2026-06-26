// Thin wrapper over TradingView Lightweight Charts (loaded globally via CDN).
// Renders candles, the zigzag overlay, and per-scenario target/invalidation lines.

const DARK = {
  bg: '#05050e', text: '#b8b8cc',
  grid: 'rgba(255,255,255,0.03)', border: 'rgba(240,165,0,0.15)',
  up: '#00ff88', down: '#ff3058', zig: '#f0a500', invalid: '#ff3058',
  scenario: ['#00d4ff', '#b388ff', '#ffcc44', '#ff7744'],
};
const LIGHT = {
  bg: '#f4f5fb', text: '#1a1a3a',
  grid: 'rgba(0,0,100,0.04)', border: 'rgba(0,0,100,0.12)',
  up: '#007744', down: '#cc2244', zig: '#c07800', invalid: '#cc2244',
  scenario: ['#0055bb', '#6600cc', '#886600', '#cc4400'],
};

function buildMarkers(T, pivots, labelMap = new Map()) {
  return pivots.map((p) => ({
    time: p.time,
    position: p.type === 'H' ? 'aboveBar' : 'belowBar',
    color: p.type === 'H' ? T.down : T.up,
    shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
    text: labelMap.get(p.time) ?? (p.tentative ? '?' : ''),
  }));
}

export function createWaveChart(container, dark = true) {
  const LC = window.LightweightCharts;
  let T = { ...(dark ? DARK : LIGHT) };

  const chart = LC.createChart(container, {
    layout: { background: { color: T.bg }, textColor: T.text, fontFamily: 'JetBrains Mono, monospace' },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: { borderColor: T.border },
    timeScale: { borderColor: T.border, timeVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  });

  const candles = chart.addCandlestickSeries({
    upColor: T.up, downColor: T.down,
    wickUpColor: T.up, wickDownColor: T.down,
    borderVisible: false,
  });

  const zig = chart.addLineSeries({
    color: T.zig, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  let priceLines = [];
  let projSeries = [];
  let _allPivots = [];
  let _labelMap = new Map();

  function clearOverlaysImpl() {
    priceLines.forEach((pl) => candles.removePriceLine(pl));
    priceLines = [];
    projSeries.forEach((s) => chart.removeSeries(s));
    projSeries = [];
  }

  function setWaveLabelsImpl(anchorPivots, waveLabels) {
    _labelMap = new Map(anchorPivots.map((p, i) => [p.time, waveLabels[i]]));
    candles.setMarkers(buildMarkers(T, _allPivots, _labelMap));
  }

  function drawChannelImpl(anchorPivots, color) {
    if (anchorPivots.length < 3) return;
    const [a, b, c] = anchorPivots.slice(-3);
    if (c.time <= a.time) return;
    const slope = (c.price - a.price) / (c.time - a.time);
    const paraAtA = b.price - slope * (b.time - a.time);
    const paraAtC = b.price + slope * (c.time - b.time);
    const addDiag = (v1, v2, style) => {
      const s = chart.addLineSeries({
        color, lineWidth: 1, lineStyle: style,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([{ time: a.time, value: v1 }, { time: c.time, value: v2 }]);
      projSeries.push(s);
    };
    addDiag(a.price, c.price, LC.LineStyle.Solid);
    addDiag(paraAtA, paraAtC, LC.LineStyle.Dashed);
  }

  return {
    chart,
    scenarioColor: (i) => T.scenario[i % T.scenario.length],

    setTheme(dark) {
      T = { ...(dark ? DARK : LIGHT) };
      chart.applyOptions({
        layout: { background: { color: T.bg }, textColor: T.text },
        grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
        rightPriceScale: { borderColor: T.border },
        timeScale: { borderColor: T.border },
      });
      candles.applyOptions({
        upColor: T.up, downColor: T.down,
        wickUpColor: T.up, wickDownColor: T.down,
      });
      zig.applyOptions({ color: T.zig });
      if (_allPivots.length) candles.setMarkers(buildMarkers(T, _allPivots, _labelMap));
    },

    setCandles(data) { candles.setData(data); },

    setZigzag(pivots) {
      _allPivots = pivots;
      _labelMap = new Map();
      zig.setData(pivots.map((p) => ({ time: p.time, value: p.price })));
      candles.setMarkers(buildMarkers(T, pivots));
    },

    clearOverlays: clearOverlaysImpl,
    drawChannel: drawChannelImpl,
    setWaveLabels: setWaveLabelsImpl,

    clearWaveLabels() {
      _labelMap = new Map();
      candles.setMarkers(buildMarkers(T, _allPivots));
    },

    drawScenario(s, idx) {
      const color = this.scenarioColor(idx);
      s.targets.forEach((t, i) => {
        priceLines.push(candles.createPriceLine({
          price: t.price, color, lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted,
          axisLabelVisible: i === 0,
          title: i === 0 ? `S${idx + 1} ${t.label}` : '',
        }));
      });
      if (Number.isFinite(s.invalidation)) {
        priceLines.push(candles.createPriceLine({
          price: s.invalidation, color: T.invalid, lineWidth: 1,
          lineStyle: LC.LineStyle.Dashed,
          axisLabelVisible: false, title: `S${idx + 1} inval`,
        }));
      }
    },

    highlightScenario(s, idx) {
      clearOverlaysImpl();
      const color = this.scenarioColor(idx);
      s.targets.forEach((t) => {
        priceLines.push(candles.createPriceLine({
          price: t.price, color, lineWidth: 2,
          lineStyle: LC.LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${t.label}  $${Math.round(t.price).toLocaleString()}`,
        }));
      });
      if (s.tp?.price && s.tp.price !== s.targets[0]?.price) {
        priceLines.push(candles.createPriceLine({
          price: s.tp.price, color, lineWidth: 3,
          lineStyle: LC.LineStyle.Solid,
          axisLabelVisible: true,
          title: `TP  $${Math.round(s.tp.price).toLocaleString()}`,
        }));
      }
      if (Number.isFinite(s.invalidation)) {
        priceLines.push(candles.createPriceLine({
          price: s.invalidation, color: T.invalid, lineWidth: 2,
          lineStyle: LC.LineStyle.Dashed,
          axisLabelVisible: true,
          title: `✕ inval  $${Math.round(s.invalidation).toLocaleString()}`,
        }));
      }
      if (s.anchorPivots) drawChannelImpl(s.anchorPivots, color + '88');
      if (s.anchorPivots && s.waveLabels) setWaveLabelsImpl(s.anchorPivots, s.waveLabels);
    },

    fit() { chart.timeScale().fitContent(); },
  };
}
