# Wave Engine

Elliott Wave **scenario projection** for BTC/ETH. Instead of a single signal, it
reads market structure and proposes *multiple* potential outcomes, each ranked by
model confidence and carrying a price/Fibonacci target zone and an **invalidation
level** (the price that kills that count).

> Replaces the previous macro-indicator dashboards (archived in [`legacy/`](legacy/)).
> Those indicators were slow-moving by design and never tracked price fluctuation.

## Status — BTC daily proof-of-concept

First milestone: prove the pipeline on one asset / one timeframe before adding
multi-timeframe (fractal) nesting and ETH.

Pipeline:

1. **`src/core/data.js`** — paginated Binance daily klines.
2. **`src/core/zigzag.js`** — ATR-scaled swing/pivot reduction (the structural backbone).
3. **`src/core/fib.js`** — retracement / extension / projection helpers.
4. **`src/core/elliott.js`** — Elliott hard-rule checks + scenario templates
   (impulse-complete, wave 3, wave 5, zigzag-C, regular/expanded flat-C, continuation).
5. **`src/core/scoring.js`** — normalized probabilities + directional lean.
6. **`src/ui/`** — TradingView Lightweight Charts view + ranked scenario panel.

The `core` modules are pure functions with no DOM/network and are unit-tested.

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
- [ ] Multi-timeframe (10m/15m · 1h · 4h · daily) with fractal nesting + cross-TF alignment
- [ ] ETH
- [ ] Semi-auto controls: lock/override the primary count, then re-project
- [ ] Triangles, WXY combinations, running flats
- [ ] Backtest harness to calibrate probabilities
- [ ] Re-wire the archived email-alert harness to scenario/invalidation events
