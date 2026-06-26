// Thin wrapper over TradingView Lightweight Charts (loaded globally via CDN).
// Renders candles, the zigzag overlay, and per-scenario target/invalidation lines.

const COLORS = {
  up: '#00ff88', down: '#ff3058', zig: '#f0a500',
  scenario: ['#00d4ff', '#b388ff', '#ffcc44', '#ff7744'],
  invalid: '#ff3058',
};

function buildMarkers(pivots, labelMap = new Map()) {
  return pivots.map((p) => ({
    time: p.time,
    position: p.type === 'H' ? 'aboveBar' : 'belowBar',
    color: p.type === 'H' ? COLORS.down : COLORS.up,
    shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
    text: labelMap.get(p.time) ?? (p.tentative ? '?' : ''),
  }));
}

export function createWaveChart(container) {
  const LC = window.LightweightCharts;
  const chart = LC.createChart(container, {
    layout: { background: { color: '#05050e' }, textColor: '#b8b8cc', fontFamily: 'JetBrains Mono, monospace' },
    grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
    rightPriceScale: { borderColor: 'rgba(240,165,0,0.15)' },
    timeScale: { borderColor: 'rgba(240,165,0,0.15)', timeVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  });

  const candles = chart.addCandlestickSeries({
    upColor: COLORS.up, downColor: COLORS.down,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down,
    borderVisible: false,
  });

  const zig = chart.addLineSeries({
    color: COLORS.zig, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  let priceLines = [];
  let projSeries = [];
  let _allPivots = [];

  function clearOverlaysImpl() {
    priceLines.forEach((pl) => candles.removePriceLine(pl));
    priceLines = [];
    projSeries.forEach((s) => chart.removeSeries(s));
    projSeries = [];
  }

  function setWaveLabelsImpl(anchorPivots, waveLabels) {
    const labelMap = new Map(anchorPivots.map((p, i) => [p.time, waveLabels[i]]));
    candles.setMarkers(buildMarkers(_allPivots, labelMap));
  }

  // Draw the Elliott channel for the scenario's anchor pivots.
  // Uses the last 3 anchors: base line through a→c, parallel through b.
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
    scenarioColor: (i) => COLORS.scenario[i % COLORS.scenario.length],

    setCandles(data) { candles.setData(data); },

    setZigzag(pivots) {
      _allPivots = pivots;
      zig.setData(pivots.map((p) => ({ time: p.time, value: p.price })));
      candles.setMarkers(buildMarkers(pivots));
    },

    clearOverlays: clearOverlaysImpl,

    clearWaveLabels() {
      candles.setMarkers(buildMarkers(_allPivots));
    },

    // Default multi-scenario view: draw top N scenarios as dotted price lines.
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
          price: s.invalidation, color: COLORS.invalid, lineWidth: 1,
          lineStyle: LC.LineStyle.Dashed,
          axisLabelVisible: false, title: `S${idx + 1} inval`,
        }));
      }
    },

    // Expanded single-scenario view: channel + labeled pivots + prominent levels.
    highlightScenario(s, idx) {
      clearOverlaysImpl();
      const color = this.scenarioColor(idx);

      // Draw targets prominently with price in the label
      s.targets.forEach((t) => {
        priceLines.push(candles.createPriceLine({
          price: t.price, color, lineWidth: 2,
          lineStyle: LC.LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${t.label}  $${Math.round(t.price).toLocaleString()}`,
        }));
      });

      // TP confluence zone (from enrichment)
      if (s.tp?.price && s.tp.price !== s.targets[0]?.price) {
        priceLines.push(candles.createPriceLine({
          price: s.tp.price, color, lineWidth: 3,
          lineStyle: LC.LineStyle.Solid,
          axisLabelVisible: true,
          title: `TP  $${Math.round(s.tp.price).toLocaleString()}`,
        }));
      }

      // Invalidation
      if (Number.isFinite(s.invalidation)) {
        priceLines.push(candles.createPriceLine({
          price: s.invalidation, color: COLORS.invalid, lineWidth: 2,
          lineStyle: LC.LineStyle.Dashed,
          axisLabelVisible: true,
          title: `✕ inval  $${Math.round(s.invalidation).toLocaleString()}`,
        }));
      }

      // Elliott channel (the "tunnel")
      if (s.anchorPivots) drawChannelImpl(s.anchorPivots, color + '88');

      // Wave labels on pivot markers
      if (s.anchorPivots && s.waveLabels) setWaveLabelsImpl(s.anchorPivots, s.waveLabels);
    },

    fit() { chart.timeScale().fitContent(); },
  };
}
