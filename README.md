# Indiktor — Flat Pattern Engine

Elliott-Wave **flat-correction** detector and **predictive projection** engine for
BTC/ETH. It reads market structure from ATR-scaled pivots, classifies completed
flat corrections (8 variants), and — while a flat is still forming — projects the
price **zones** the next pivot must reach, an **invalidation** level, and a
measured-move **take-profit**.

> Replaces the earlier macro-indicator dashboards (archived in [`legacy/`](legacy/))
> and the Elliott *scenario-projection* prototype that preceded the flat engine.

## Flat family

Every flat is identified by two ratios on the O→A→B→C pivots:

- `rB = (A − B) / (A − O)` — how far B retraces leg A (`> 1` ⟺ B breaks past O)
- `pC = (C − A) / (A − O)` — whether C breaks past A

The 2×2 table gives the type — **regular · running · expanding · contracting** —
each in **bull / bear** form (8 patterns). See [`src/core/flats.js`](src/core/flats.js).

## Engine pipeline

Pure, unit-tested `core` modules — no DOM, no network:

1. **[`data.js`](src/core/data.js)** — paginated Binance klines + resampling.
2. **[`zigzag.js`](src/core/zigzag.js)** — ATR-scaled swing/pivot reduction (the structural backbone).
3. **[`flats.js`](src/core/flats.js)** — flat detector: prototypicality bands, break tests,
   confidence components, the non-flat gate, and live (in-progress) flat detection.
4. **[`predict.js`](src/core/predict.js)** — predictive engine: *inverts* the band ratios to derive
   future price zones (completion / invalidation / TP) per hypothesis, then beams the top-k.
5. **[`timing.js`](src/core/timing.js)** — Fibonacci duration priors (soft, never a gate).
6. **[`fractal.js`](src/core/fractal.js)** — inter-timeframe constraint propagation (concordant /
   contradictory / impossible) + scale-stability and nesting coherence.
7. **[`compose.js`](src/core/compose.js)** — vertical recursion (sub-flats inside legs) and
   horizontal chaining of consecutive flats.
8. **[`ghost.js`](src/core/ghost.js)** — per-branch "ghost candle" projection paths (seg3
   corrective + seg5 impulse), gated on a determined type, drawn for a selected/pinned hypothesis.
9. **[`idb.js`](src/core/idb.js)** — minimal IndexedDB key→value store (snapshots, annotations).

## Feedback loop (100% client)

Capture → store → evaluate → estimate → optimise → calibrate → apply. Each browser tunes on its
own snapshots (no shared/global config); `snapshots.html` is a local dashboard.

- **[`snapshot.js`](src/core/snapshot.js)** — `takeSnapshot` freezes the ranked hypotheses;
  `evaluateSnapshotPath` walks the candles that printed **after** capture and resolves each
  hypothesis by **first touch** (TP zone vs hard invalidation), per-hypothesis, with a pending→
  `expired` horizon. Headline outcome = the **primary** hypothesis (no "any-hit-wins").
- **[`params.js`](src/core/params.js)** — canonical tunable param set + stable provenance hash.
  Every snapshot is tagged with its param config + hash, so outcomes attribute to a config.
- **[`idb.js`](src/core/idb.js)** — IndexedDB: a `kv` store + a provenance-indexed `snapshots`
  object store (no localStorage quota, no 60-cap).
- **[`estimate.js`](src/core/estimate.js)** — partial-pooling / shrinkage hit-rate estimates per
  segment (TF[, ×type]) and per (segment×param): `rate = (hits + k·prior)/(n + k)`.
- **[`optimize.js`](src/core/optimize.js)** + **[`optimize.worker.js`](src/core/optimize.worker.js)** —
  client param sweep: slide an as-of cursor over history, run the real predict pipeline per param
  combo, resolve first-touch, rank via `estimate.js`. Runs in a Web Worker (non-blocking).
- **[`calibrate.js`](src/core/calibrate.js)** — interpretable 1-D logistic mapping raw confidence →
  empirical hit rate (+ reliability table); identity below `MIN_SAMPLES` (30). Kept separate from
  param optimisation.
- **[`timingStats.js`](src/core/timingStats.js)** — learns empirical leg-duration windows
  ([p20,p80] per TF/type) from resolved hits; `timing.js` uses them when available, else the
  Fibonacci priors (always soft).
- **[`snapshots.html`](snapshots.html)** — dashboard: metrics, calibration reliability,
  per-hypothesis outcomes, **Resolve** (path-resolve pending), and **⚙ Optimiser** (worker sweep →
  per-segment proposals → human-in-the-loop **appliquer**, which the chart picks up via
  `applied-params`).

The chart captures a snapshot at most once every 2 h **per (asset, TF)**, and passively
path-resolves snapshots for the series on screen.

## Run

Static site — serve the folder and open it:

```bash
python -m http.server 8000   # then visit http://localhost:8000
```

- `index.html` — chart + analysis/prediction panel.
- `snapshots.html` — snapshot monitoring + calibration.

## Test

```bash
npm test     # node --test, zero dependencies
```

## Caveat

Confidence is **model-derived** (band fit + break clarity + channel cleanliness + fractal
consistency), *not* a statistically calibrated probability — until enough snapshots resolve and
`calibrate.js` fits. The reliability table on the snapshots page shows how raw confidence has
actually mapped to outcomes so far.

## Roadmap

- [x] Flat detector: 8 patterns from `rB`/`pC`, prototypicality bands, break tests, non-flat gate
- [x] Predictive engine: band inversion → completion/invalidation/TP zones, beam, timing priors
- [x] Inter-TF fractal constraints + vertical/horizontal composition
- [x] Ghost-candle projection (structured seg3/seg5) + pin
- [x] Feedback: snapshot → path-aware first-touch resolve → per-hypothesis outcomes → calibration
- [ ] Drive snapshot evaluation across all stored series automatically (not just the one on screen)
- [ ] Multi-TF goal wiring in the UI (daily hypothesis as goal for the 4h beam)
- [ ] Backtest-driven parameter recommendations surfaced in the UI
- [ ] Other corrective families: zigzag, triangle, WXY combinations
