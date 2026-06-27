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

function buildPivotMarkers(T, pivots, labelMap = new Map()) {
  return pivots.map((p) => ({
    time: p.time,
    position: p.type === 'H' ? 'aboveBar' : 'belowBar',
    color: p.type === 'H' ? T.down : T.up,
    shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
    text: labelMap.get(p.time) ?? (p.tentative ? '?' : ''),
  }));
}

function mergeMarkers(pivotMarkers, extraMarkers = []) {
  return [...pivotMarkers, ...extraMarkers].sort((a, b) => a.time - b.time);
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
  let annotSeries = [];     // annotation + similarity overlays
  let annotPriceLines = []; // price lines for annotation points
  let flatSeries = [];      // historical flat pattern overlays
  let flatPriceLines = [];
  let liveSeries = [];      // in-progress flat overlay
  let livePriceLines = [];
  let ghostSeries = null;
  let _allPivots = [];
  let _labelMap = new Map();
  let _extraMarkers = [];   // annotation / similarity markers
  let _flatMarkers  = [];   // flat pattern label markers
  let _clickUnsub = null;

  function refreshMarkers() {
    candles.setMarkers(mergeMarkers(
      buildPivotMarkers(T, _allPivots, _labelMap),
      [..._flatMarkers, ..._extraMarkers],
    ));
  }

  function clearOverlaysImpl() {
    priceLines.forEach((pl) => candles.removePriceLine(pl));
    priceLines = [];
    projSeries.forEach((s) => chart.removeSeries(s));
    projSeries = [];
    if (ghostSeries) { chart.removeSeries(ghostSeries); ghostSeries = null; }
  }

  function setWaveLabelsImpl(anchorPivots, waveLabels) {
    _labelMap = new Map(anchorPivots.map((p, i) => [p.time, waveLabels[i]]));
    refreshMarkers();
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

    // --- All flat family: draw the B-wave parallel channel (the "tunnel") ---
    // The KEY visual of any flat is the parallel channel the candles travel through
    // during the B wave. A "bullish tunnel" after a bearish A wave IS the regular
    // flat's B wave. The tunnel's slope + width completely identifies the flat type:
    //   regular flat  : B stays within A's range (mild slope, bounded by A's levels)
    //   running flat  : B ran past A's origin (steeper slope, A-end visible as C floor)
    //   expanding flat: same as running flat, but C also expected to break A-end
    //   contracting flat: B is shorter than A (slight slope, compressing width)
    if (id === 'flat-regular' || id === 'running-flat' || id === 'flat-expanding' || id === 'flat-contracting') {
      const p = anchorPivots; // [A-start, A-end, B-end]
      if (p.length < 3) return;
      const bDuration = Math.max(1, p[2].time - p[1].time);
      const slope     = (p[2].price - p[1].price) / bDuration;
      // Channel base runs from A-end along B's direction.
      // Channel parallel: shifted by (A-start - A-end) in price — the width of A.
      const offset    = p[0].price - p[1].price; // width = A's price range
      const baseAt    = (t) => p[1].price + slope * (t - p[1].time);
      const paraAt    = (t) => baseAt(t) + offset;
      // Extend forward by one B-wave duration to show where C should land.
      const extTo     = p[2].time + bDuration;

      const addTunnel = (t1, v1, t2, v2, style, alpha) => {
        const s = chart.addLineSeries({
          color: T.zig + alpha, lineWidth: 1, lineStyle: style,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData([{ time: t1, value: v1 }, { time: t2, value: v2 }]);
        projSeries.push(s);
      };
      // Draw the tunnel: solid base (lower/upper wall of B wave) + dashed parallel
      addTunnel(p[1].time, baseAt(p[1].time), extTo, baseAt(extTo), LC.LineStyle.Solid,  '99');
      addTunnel(p[1].time, paraAt(p[1].time), extTo, paraAt(extTo), LC.LineStyle.Dashed, '66');

      // A-end key level: the boundary C must respect or break
      priceLines.push(candles.createPriceLine({
        price: p[1].price, color: T.zig + '44', lineWidth: 1,
        lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false,
        title: id === 'flat-contracting' ? 'C-ceil' : 'A-end',
      }));

      // For running/expanding: also show A-origin (the level B already broke, now key resistance)
      if (id === 'running-flat' || id === 'flat-expanding') {
        priceLines.push(candles.createPriceLine({
          price: p[0].price, color: T.zig + '33', lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: 'A-orig',
        }));
      }
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

  // Draw a flat pattern as a parallel band (rectangle) from A-start to C-end,
  // plus the ABC polyline inside showing the structure.
  function _drawFlatABC(p, color, lineWidth) {
    const col = color.slice(0, 7);

    const prices = [p.aStart.price, p.aEnd.price, p.bEnd.price, p.cEnd.price];
    const roof  = Math.max(...prices);
    const floor = Math.min(...prices);
    const t1    = p.aStart.time;
    const t2    = p.cEnd.time;

    // Filled band: AreaSeries from roof level (fills downward with low opacity)
    const fill = chart.addAreaSeries({
      topColor:    col + '22',
      bottomColor: col + '08',
      lineColor:   'transparent',
      lineWidth:   0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    fill.setData([{ time: t1, value: roof }, { time: t2, value: roof }]);
    flatSeries.push(fill);

    // Top boundary — solid horizontal line
    const topLine = chart.addLineSeries({
      color: col + 'cc', lineWidth: lineWidth, lineStyle: LC.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    topLine.setData([{ time: t1, value: roof }, { time: t2, value: roof }]);
    flatSeries.push(topLine);

    // Bottom boundary — solid horizontal line
    const botLine = chart.addLineSeries({
      color: col + 'cc', lineWidth: lineWidth, lineStyle: LC.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    botLine.setData([{ time: t1, value: floor }, { time: t2, value: floor }]);
    flatSeries.push(botLine);

    // ABC polyline inside the band (shows the internal W/M structure)
    const abc = chart.addLineSeries({
      color: col + (lineWidth > 1 ? 'ff' : '66'),
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    abc.setData([
      { time: p.aStart.time, value: p.aStart.price },
      { time: p.aEnd.time,   value: p.aEnd.price },
      { time: p.bEnd.time,   value: p.bEnd.price },
      { time: p.cEnd.time,   value: p.cEnd.price },
    ]);
    flatSeries.push(abc);

    // Label marker at C-end
    const confStr = p.confidence != null ? ` ${(p.confidence * 100).toFixed(0)}%` : '';
    _flatMarkers.push({
      time:     p.cEnd.time,
      position: p.bias === 'bull' ? 'belowBar' : 'aboveBar',
      color:    col + 'cc',
      shape:    'circle',
      text:     p.label + confStr,
      size:     1,
    });
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
      if (_allPivots.length) refreshMarkers();
    },

    setCandles(data) { candles.setData(data); },

    setZigzag(pivots) {
      _allPivots = pivots;
      _labelMap = new Map();
      zig.setData(pivots.map((p) => ({ time: p.time, value: p.price })));
      refreshMarkers();
    },

    clearOverlays: clearOverlaysImpl,
    drawChannel: drawChannelImpl,
    setWaveLabels: setWaveLabelsImpl,

    clearWaveLabels() {
      _labelMap = new Map();
      refreshMarkers();
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

    // ── Annotation & similarity overlays ────────────────────────────────────
    subscribeClick(callback) {
      if (_clickUnsub) { chart.unsubscribeClick(_clickUnsub); }
      _clickUnsub = (param) => {
        if (!param.point || !param.time) return;
        const price = candles.coordinateToPrice(param.point.y);
        if (price != null) callback(param.time, price);
      };
      chart.subscribeClick(_clickUnsub);
    },

    unsubscribeClick() {
      if (_clickUnsub) { chart.unsubscribeClick(_clickUnsub); _clickUnsub = null; }
    },

    drawAnnotPoints(points) {
      annotPriceLines.forEach(pl => candles.removePriceLine(pl));
      annotPriceLines = [];
      annotSeries.forEach(s => chart.removeSeries(s));
      annotSeries = [];

      const ROLES  = ['A', 'B', 'C'];
      const COLORS = ['#00ff88', '#f0a500', '#00d4ff'];

      points.forEach((pt, i) => {
        annotPriceLines.push(candles.createPriceLine({
          price: pt.price, color: COLORS[i] + 'aa', lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: ROLES[i],
        }));
      });

      if (points.length >= 2) {
        const line = chart.addLineSeries({
          color: '#f0a50099', lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        line.setData(points.map(p => ({ time: p.time, value: p.price })));
        annotSeries.push(line);
      }

      _extraMarkers = points.map((pt, i) => ({
        time: pt.time,
        position: i === 1 ? (points[0] && pt.price > points[0].price ? 'aboveBar' : 'belowBar') : 'belowBar',
        color: COLORS[i],
        shape: 'circle',
        text: ROLES[i],
        size: 2,
      }));
      refreshMarkers();
    },

    clearAnnotPoints() {
      annotPriceLines.forEach(pl => candles.removePriceLine(pl));
      annotPriceLines = [];
      annotSeries.forEach(s => chart.removeSeries(s));
      annotSeries = [];
      _extraMarkers = [];
      refreshMarkers();
    },

    drawSimilarMatches(matches) {
      annotSeries.forEach(s => chart.removeSeries(s));
      annotSeries = [];
      _extraMarkers = [];

      const COL = { regular: '#f0a500', running: '#00d4ff', expanding: '#ff7744', contracting: '#5ccf7a' };

      matches.forEach(m => {
        const col = COL[m.type] ?? '#aaaaaa';
        const line = chart.addLineSeries({
          color: col + '88', lineWidth: 2, lineStyle: LC.LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        line.setData([
          { time: m.aEnd.time, value: m.aEnd.price },
          { time: m.bEnd.time, value: m.bEnd.price },
        ]);
        annotSeries.push(line);

        _extraMarkers.push({
          time: m.bEnd.time,
          position: m.bias === 'bull' ? 'aboveBar' : 'belowBar',
          color: col + 'cc',
          shape: 'circle',
          text: `~${(m.similarity * 100).toFixed(0)}%`,
          size: 1,
        });
      });
      refreshMarkers();
    },

    clearSimilarMatches() {
      annotSeries.forEach(s => chart.removeSeries(s));
      annotSeries = [];
      _extraMarkers = [];
      refreshMarkers();
    },

    // ── Flat pattern overlays ────────────────────────────────────────────────

    drawFlatPatterns(patterns) {
      flatSeries.forEach(s => chart.removeSeries(s));
      flatPriceLines.forEach(pl => candles.removePriceLine(pl));
      flatSeries = [];
      flatPriceLines = [];
      _flatMarkers = [];

      const COL = { regular: '#f0a500', running: '#00d4ff', expanding: '#ff7744', contracting: '#5ccf7a' };

      for (const p of patterns) {
        const col = COL[p.type] ?? '#888888';
        _drawFlatABC(p, col + 'aa', 1);
      }
      refreshMarkers();
    },

    highlightFlat(patterns, selectedIdx) {
      flatSeries.forEach(s => chart.removeSeries(s));
      flatPriceLines.forEach(pl => candles.removePriceLine(pl));
      flatSeries = [];
      flatPriceLines = [];
      _flatMarkers = [];

      const COL = { regular: '#f0a500', running: '#00d4ff', expanding: '#ff7744', contracting: '#5ccf7a' };

      patterns.forEach((p, i) => {
        const col = COL[p.type] ?? '#888888';
        if (i === selectedIdx) {
          _drawFlatABC(p, col, 2);
          // Key level lines for selected pattern
          flatPriceLines.push(candles.createPriceLine({
            price: p.aEnd.price, color: col + '88', lineWidth: 1,
            lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'A-end',
          }));
          if (p.type === 'running' || p.type === 'expanding') {
            flatPriceLines.push(candles.createPriceLine({
              price: p.aStart.price, color: col + '55', lineWidth: 1,
              lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'A-start',
            }));
          }
          // Scroll chart to the pattern
          chart.timeScale().setVisibleRange({
            from: p.aStart.time - (p.cEnd.time - p.aStart.time) * 0.15,
            to:   p.cEnd.time  + (p.cEnd.time - p.aStart.time) * 0.4,
          });
        } else {
          _drawFlatABC(p, col + '28', 1);
        }
      });
      refreshMarkers();
    },

    drawLiveFlat(live) {
      liveSeries.forEach(s => chart.removeSeries(s));
      livePriceLines.forEach(pl => candles.removePriceLine(pl));
      liveSeries = [];
      livePriceLines = [];

      const col = '#ffffff';
      const ab = chart.addLineSeries({
        color: col + 'bb', lineWidth: 2, lineStyle: LC.LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      ab.setData([
        { time: live.aStart.time, value: live.aStart.price },
        { time: live.aEnd.time,   value: live.aEnd.price },
        { time: live.bEnd.time,   value: live.bEnd.price },
      ]);
      liveSeries.push(ab);

      if (live.cTargets?.min != null) {
        livePriceLines.push(candles.createPriceLine({
          price: live.cTargets.min, color: col + '66', lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true,
          title: `C min (${live.possibleTypes.join('/')})`,
        }));
      }
      if (live.cTargets?.max != null) {
        livePriceLines.push(candles.createPriceLine({
          price: live.cTargets.max, color: col + '44', lineWidth: 1,
          lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: '',
        }));
      }
    },

    clearFlatPatterns() {
      flatSeries.forEach(s => chart.removeSeries(s));
      flatPriceLines.forEach(pl => candles.removePriceLine(pl));
      flatSeries = [];
      flatPriceLines = [];
      _flatMarkers = [];
      liveSeries.forEach(s => chart.removeSeries(s));
      livePriceLines.forEach(pl => candles.removePriceLine(pl));
      liveSeries = [];
      livePriceLines = [];
      refreshMarkers();
    },

    fit() { chart.timeScale().fitContent(); },
  };
}
