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
    timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false },
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
  let ghostSeries = null;  // separate from projSeries so it can be removed independently
  let _allPivots = [];
  let _labelMap = new Map();

  function clearOverlaysImpl() {
    priceLines.forEach((pl) => candles.removePriceLine(pl));
    priceLines = [];
    projSeries.forEach((s) => chart.removeSeries(s));
    projSeries = [];
    if (ghostSeries) { chart.removeSeries(ghostSeries); ghostSeries = null; }
  }

  function setWaveLabelsImpl(anchorPivots, waveLabels) {
    _labelMap = new Map(anchorPivots.map((p, i) => [p.time, waveLabels[i]]));
    candles.setMarkers(buildMarkers(T, _allPivots, _labelMap));
  }

  function drawChannelImpl(anchorPivots, color, extendToTime = null) {
    if (anchorPivots.length < 3) return;
    const [a, b, c] = anchorPivots.slice(-3);
    if (c.time <= a.time) return;
    const slope  = (c.price - a.price) / (c.time - a.time);
    const offset = b.price - (a.price + slope * (b.time - a.time)); // parallel shift
    const baseAt = (t) => a.price + slope * (t - a.time);
    const paraAt = (t) => baseAt(t) + offset;

    // Extend the channel into the future so the projected path is visible.
    // Default: one full channel length beyond point C (the current anchor edge).
    const end = extendToTime ?? (c.time + (c.time - a.time));

    const addLine = (t1, v1, t2, v2, style) => {
      const s = chart.addLineSeries({
        color, lineWidth: 1, lineStyle: style,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([{ time: t1, value: v1 }, { time: t2, value: v2 }]);
      projSeries.push(s);
    };
    addLine(a.time, baseAt(a.time), end, baseAt(end), LC.LineStyle.Solid);
    addLine(a.time, paraAt(a.time), end, paraAt(end), LC.LineStyle.Dashed);

    // Translucent band: fill from the upper trendline downward at low opacity.
    // LW Charts v4 has no native band-between-two-lines primitive; filling from
    // the upper line is the closest approximation — both visible trendlines still
    // clearly delimit the zone so the fill reads as the channel interior.
    const upperAt = offset >= 0 ? paraAt : baseAt;
    const hex     = color.slice(0, 7); // strip any existing alpha suffix
    const band = chart.addAreaSeries({
      lineColor:    'transparent',
      topColor:     hex + '28', // ~16% opacity at the trendline
      bottomColor:  hex + '05', // fades to near-transparent below
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      lineWidth: 0,
    });
    band.setData([
      { time: a.time, value: upperAt(a.time) },
      { time: end,    value: upperAt(end) },
    ]);
    projSeries.push(band);
  }

  function drawPatternShapeImpl(scenario, anchorPivots) {
    if (!anchorPivots || anchorPivots.length < 2) return;
    const id = scenario.id;

    // --- Triangles: draw BOTH converging/diverging trendlines ---
    if ((id === 'contracting-triangle' || id === 'expanding-triangle') && anchorPivots.length >= 6) {
      const p = anchorPivots;
      // Determine which pivots are highs vs lows based on first wave direction
      const firstLegDir = Math.sign(p[1].price - p[0].price);
      // Even indices go one direction, odd the other
      // For DOWN first leg: p[0],p[2],p[4] are HIGHs; p[1],p[3],p[5] are LOWs
      const setA = [p[0], p[2], p[4]];  // pivot extremes of one side
      const setB = [p[1], p[3], p[5]];  // pivot extremes of the other side
      const addTrendLine = (pa, pb, style) => {
        const s = chart.addLineSeries({
          color: T.zig + 'aa', lineWidth: 1, lineStyle: style,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData([{time: pa.time, value: pa.price}, {time: pb.time, value: pb.price}]);
        projSeries.push(s);
      };
      addTrendLine(setA[0], setA[2], LC.LineStyle.Solid);
      addTrendLine(setB[0], setB[2], LC.LineStyle.Solid);
      return;
    }

    // --- Regular flat: horizontal box between A's two extremes ---
    // B stayed within A's range — draw A-origin (upper bound of correction) and
    // A-end/B-max (lower bound). After C breaks the A-end level, the prior trend resumes.
    if (id === 'flat-regular') {
      const p = anchorPivots; // [A-start, A-end/B-start, B-end]
      if (p.length < 3) return;
      [p[0].price, p[1].price].forEach((lvl, i) => {
        priceLines.push(candles.createPriceLine({
          price: lvl, color: T.zig + '55', lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false,
          title: i === 0 ? 'A-orig' : 'A-end',
        }));
      });
      return;
    }

    // --- Running flat: diagonal "running" trendline + B-end level ---
    // B broke PAST A's origin, showing the trend never really stopped.
    // The diagonal line from A-end to B-end is the visual signature ("Running daily").
    // C is expected to stay above A-end (short pullback before trend explosion).
    if (id === 'running-flat') {
      const p = anchorPivots; // [A-start, A-end/B-start, B-end]
      if (p.length < 3) return;
      // B-end horizontal: the new territory B reached (trend continuation high/low)
      priceLines.push(candles.createPriceLine({
        price: p[2].price, color: T.zig + '55', lineWidth: 1,
        lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: 'B-ext',
      }));
      // A-end / C-target floor: C should not break below this
      priceLines.push(candles.createPriceLine({
        price: p[1].price, color: T.zig + '44', lineWidth: 1,
        lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: 'A-end',
      }));
      // Diagonal "running" trendline: A-end → B-end. This ascending (or descending)
      // line shows the direction in which B ran past A's origin — the trend's pulse.
      const runLine = chart.addLineSeries({
        color: T.zig + '99', lineWidth: 1, lineStyle: LC.LineStyle.Solid,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      runLine.setData([
        { time: p[1].time, value: p[1].price },
        { time: p[2].time, value: p[2].price },
      ]);
      projSeries.push(runLine);
      return;
    }

    // --- Zigzag / double-zigzag: draw horizontal target zone band ---
    if (id === 'zigzag-c' || id === 'double-zigzag') {
      if (scenario.targets.length >= 2) {
        const prices = scenario.targets.map(t => t.price);
        const lo = Math.min(...prices);
        const hi = Math.max(...prices);
        [lo, hi].forEach((lvl, i) => {
          priceLines.push(candles.createPriceLine({
            price: lvl,
            color: T.scenario[0] + '55',
            lineWidth: 1,
            lineStyle: LC.LineStyle.Dotted,
            axisLabelVisible: false,
            title: i === 0 ? 'zone lo' : 'zone hi',
          }));
        });
      }
      return;
    }

    // --- Impulse patterns (wave-3, wave-5, impulse-complete, continuation): ---
    // The channel is already drawn by drawChannelImpl in highlightScenario.
    // Add a subtle area wash so the channel "region" is visible.
    // Use the top channel line as an AreaSeries with very low opacity.
    if (anchorPivots.length >= 3) {
      const [a, b, c] = anchorPivots.slice(-3);
      if (c.time <= a.time) return;
      const color = T.scenario[0];
      const area = chart.addAreaSeries({
        lineColor: 'transparent',
        topColor: color + '0d',     // ~5% opacity fill beneath upper channel line
        bottomColor: 'transparent',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        lineWidth: 0,
      });
      area.setData([
        { time: a.time, value: a.price },
        { time: c.time, value: c.price },
      ]);
      projSeries.push(area);
    }
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

    drawGhostCandles(ghostData, projectedPivots, scenarioColor) {
      if (!ghostData?.length) return;
      if (ghostSeries) { chart.removeSeries(ghostSeries); ghostSeries = null; }
      ghostSeries = chart.addCandlestickSeries({
        upColor:        'rgba(160,160,160,0.18)',
        downColor:      'rgba(110,110,110,0.18)',
        wickUpColor:    'rgba(160,160,160,0.32)',
        wickDownColor:  'rgba(110,110,110,0.32)',
        borderUpColor:  'rgba(160,160,160,0.45)',
        borderDownColor:'rgba(110,110,110,0.45)',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      ghostSeries.setData(ghostData);

      if (projectedPivots?.length) {
        // Circle markers with wave labels at each projected turning point
        ghostSeries.setMarkers(projectedPivots.map((pv) => ({
          time: pv.time,
          position: pv.dir === 'up' ? 'aboveBar' : 'belowBar',
          color: scenarioColor ?? 'rgba(200,200,200,0.75)',
          shape: 'circle',
          text: pv.label,
          size: 1,
        })));

        // Dashed schematic polyline: start → each projected pivot.
        // Draws the "wave shape outline" so the pattern structure is visible
        // even when ghost candles are faint.
        const color = (scenarioColor ?? '#aaaaaa') + '99';
        const schematic = chart.addLineSeries({
          color,
          lineWidth: 1,
          lineStyle: LC.LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        schematic.setData([
          { time: ghostData[0].time, value: ghostData[0].open },
          ...projectedPivots.map((pv) => ({ time: pv.time, value: pv.price })),
        ]);
        projSeries.push(schematic);  // cleaned up by clearOverlays
      }
    },

    drawPatternShape: (scenario, anchorPivots) => drawPatternShapeImpl(scenario, anchorPivots),

    fit() { chart.timeScale().fitContent(); },
  };
}
