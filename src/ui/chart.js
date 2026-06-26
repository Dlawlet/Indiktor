// Thin wrapper over TradingView Lightweight Charts (loaded globally via CDN).
// Renders candles, the zigzag overlay, and per-scenario target/invalidation lines.

const COLORS = {
  up: '#00ff88', down: '#ff3058', zig: '#f0a500',
  scenario: ['#00d4ff', '#b388ff', '#ffcc44', '#ff7744'],
  invalid: '#ff3058',
};

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

  return {
    chart,
    scenarioColor: (i) => COLORS.scenario[i % COLORS.scenario.length],

    setCandles(data) { candles.setData(data); },

    setZigzag(pivots) {
      zig.setData(pivots.map((p) => ({ time: p.time, value: p.price })));
      candles.setMarkers(pivots.map((p) => ({
        time: p.time,
        position: p.type === 'H' ? 'aboveBar' : 'belowBar',
        color: p.type === 'H' ? COLORS.down : COLORS.up,
        shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
        text: p.tentative ? '?' : '',
      })));
    },

    clearOverlays() {
      priceLines.forEach((pl) => candles.removePriceLine(pl));
      priceLines = [];
      projSeries.forEach((s) => chart.removeSeries(s));
      projSeries = [];
    },

    // Draw a scenario's target zone + invalidation as labelled price lines.
    drawScenario(s, idx) {
      const color = this.scenarioColor(idx);
      s.targets.forEach((t, i) => {
        priceLines.push(candles.createPriceLine({
          price: t.price, color, lineWidth: 1,
          lineStyle: window.LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: i === 0,
          title: i === 0 ? `S${idx + 1} ${t.label}` : '',
        }));
      });
      if (Number.isFinite(s.invalidation)) {
        priceLines.push(candles.createPriceLine({
          price: s.invalidation, color: COLORS.invalid, lineWidth: 1,
          lineStyle: window.LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: false, title: `S${idx + 1} inval`,
        }));
      }
    },

    fit() { chart.timeScale().fitContent(); },
  };
}
