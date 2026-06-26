# Wave Engine

Elliott Wave **scenario projection** for BTC/ETH. Instead of a single signal, it
reads market structure and proposes *multiple* potential outcomes, each ranked by
model confidence and carrying a price/Fibonacci target zone and an **invalidation
level** (the price that kills that count).

> Replaces the previous macro-indicator dashboards (archived in [`legacy/`](legacy/)).
> Those indicators were slow-moving by design and never tracked price fluctuation.

## Status — BTC fractal engine + feedback loop

Beyond the original daily PoC, the engine now runs **fractally across 15m · 1h · 4h
· daily** with weighted cross-timeframe alignment, emits **objective TP / switch /
R:R** per scenario, and has a **feedback loop** to record what actually happened
(for later probability calibration).

Engine pipeline (pure, unit-tested `core` modules — no DOM/network):

1. **`src/core/data.js`** — paginated Binance klines + resampling.
2. **`src/core/zigzag.js`** — ATR-scaled swing/pivot reduction (the structural backbone).
3. **`src/core/fib.js`** — retracement / extension / projection helpers.
4. **`src/core/elliott.js`** — Elliott hard-rule checks + scenario templates
   (impulse-complete, wave 3, wave 5, zigzag-C, regular/expanded flat-C, continuation).
5. **`src/core/scoring.js`** — normalized probabilities + directional lean.
6. **`src/core/targets.js`** — confluence clustering → objective take-profit,
   direction-switch level, and risk/reward per scenario.
7. **`src/core/multiframe.js`** — per-timeframe runner + weighted fractal alignment.
8. **`src/ui/`** — Lightweight Charts view, timeframe tabs, fractal-alignment banner,
   ranked scenario cards (TP / R:R / invalidation).

Feedback & calibration subsystem (`src/feedback/` + `review.html`):

- **`snapshot.js`** — immutable snapshot of an analysis (with a flat feature vector).
- **`resolve.js`** — objective auto-resolver: `target-hit | invalidated | pending`,
  decided by which level price reached first (see `src/feedback/INTEGRATION.md`).
- **`store.js`** — `SnapshotStore` (IndexedDB in browser, in-memory in Node).
- **`calibrate.js`** — interpretable 1-D confidence→hit-rate calibration scaffold;
  returns raw probabilities until ≥ `MIN_SAMPLES` (30) resolved examples exist.
- **`review.html`** — review past snapshots, auto-resolve, confirm/override outcomes.

Use it: click **📸 SNAPSHOT** on the active timeframe, then open **REVIEW →** later.

## Run

It's a static site — serve the folder and open it:

```bash
python -m http.server 8000   # then visit http://localhost:8000
```

## Test

```bash
npm test     # node --test, zero dependencies
```

## Important caveat

Probabilities are **model-derived confidence** (Elliott rule satisfaction +
Fibonacci confluence + structure quality), *not* statistically calibrated
outcomes. Backtest calibration against historical wave outcomes is a planned later
phase.

## Roadmap

- [x] BTC daily PoC: pivots → rule-valid scenarios → ranked targets + invalidation
- [x] Objective TP / direction-switch / R:R via Fibonacci + structural confluence
- [x] Multi-timeframe fractal (15m · 1h · 4h · daily) + weighted cross-TF alignment
- [x] Feedback loop: snapshot → auto-resolve → review/override → dataset + calibration scaffold
- [ ] ETH + asset switcher
- [ ] Calibrate probabilities once ≥ 30 resolved samples exist (then show calibrated vs raw)
- [ ] Semi-auto controls: lock/override the primary count, then re-project
- [ ] Triangles, WXY combinations, running flats
- [ ] Richer scenario fields for resolver fidelity: snapshot enriched `tp.lo/hi`,
      a primary-target flag, and a projection horizon/expiry (per feedback INTEGRATION notes)
- [ ] Re-wire the archived email-alert harness to scenario/invalidation events
- [ ] True 10m via 5m→10m resampling (Binance has no native 10m candle)
