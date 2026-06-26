# Feedback Loop & Calibration — Integration

This subsystem records which *projected* scenario actually happened, building a
labeled dataset to (eventually) calibrate the model's probabilities. It is a
**data pipeline + light calibration scaffold** — no predictive ML / neural nets.

All modules are pure ESM with zero dependencies. The UI lives in `review.html` +
`src/ui/review.js` and never touches `index.html` / `src/ui/app.js`.

```
analyze()/rankScenarios()/enrichScenarios()
        │  snapshotAnalysis(...)            (snapshot.js, pure)
        ▼
   Snapshot record ──put──► SnapshotStore (store.js: IndexedDB | Memory)
        │                         │
        │  resolveSnapshot(...)   │  exportDataset(...) ─► calibrate(...) ─► applyCalibration(...)
        ▼ (resolve.js, pure)      ▼ (calibrate.js, pure)
   per-scenario outcome      [{features, outcome}]  reliability model (scaffold)
   target-hit | invalidated | pending
```

## The hook in `src/ui/app.js` (2–3 lines)

The other agent owns `app.js`. To start collecting data, add a snapshot call at
the end of `run()` in `app.js`, right after `ranked`/`lean` are computed. The
import line plus one statement is all that's needed:

```js
// at top with the other imports:
import { snapshotAnalysis } from '../feedback/snapshot.js';
import { createStore } from '../feedback/store.js';
const feedbackStore = createStore();

// inside run(), after rankScenarios()/enrichScenarios():
const snap = snapshotAnalysis(ranked, { asset: SYMBOL, timeframe: INTERVAL, priceAtAnalysis: last.close });
feedbackStore.put({ id: snap.id, snapshot: snap, outcomes: {} });
```

Snapshot on demand (e.g. behind a "Save snapshot" button) rather than on every
refresh, so the dataset isn't flooded with near-identical records. Then open
`review.html` to auto-resolve and confirm/override outcomes.

## Snapshot JSON schema

`snapshotAnalysis(analysis, {asset, timeframe, priceAtAnalysis})` returns an
**immutable** (deep-frozen) record:

```json
{
  "id": "string (uuid or fallback)",
  "ts": 1750000000,                     // unix SECONDS the snapshot was taken
  "asset": "BTCUSDT",
  "timeframe": "1d",
  "priceAtAnalysis": 64210.5,           // live price at analysis time
  "scenarios": [
    {
      "id": "wave-3",
      "name": "Wave 3 underway",
      "bias": "up",                     // 'up' | 'down'
      "pattern": "impulse",             // 'impulse' | 'correction' | 'continuation'
      "invalidation": 60000,            // price that kills this count
      "targets": [
        { "label": "1.618x", "ratio": 1.618, "price": 72000 }
      ],
      "features": {                     // flat, calibration-ready vector
        "prior": 0.65,
        "guideline": 0.55,
        "pattern": "impulse",
        "bias": "up",
        "targetRatios": [1.618, 2.0, 2.618],
        "invalidation": 60000,
        "probability": 0.31
      }
    }
  ]
}
```

`snapshotAnalysis` accepts a raw `analyze()` result (`{scenarios}`), the array
from `rankScenarios()`, or the enriched array from `enrichScenarios()`.

## Stored record schema (what the store persists)

The store wraps a snapshot with its outcomes so the dataset can pair
`features → realized outcome`:

```json
{
  "id": "same as snapshot.id (the key)",
  "snapshot": { /* Snapshot, as above */ },
  "outcomes": {
    "wave-3": {
      "outcome": "target-hit",          // 'target-hit' | 'invalidated' | 'pending'
      "resolver": "auto",               // 'auto' (resolve.js) | 'human' (override)
      "price": 72000,                   // level that was hit, or null
      "time": 1750500000,               // unix seconds of the deciding candle, or null
      "reason": "price reached target zone edge 72000"
    }
  },
  "updatedTs": 1750500050
}
```

`SnapshotStore` contract (all async): `put(record) → id`, `get(id) → record|undefined`,
`all() → record[]` (newest first), `delete(id) → void`. Implementations:
`IndexedDbStore` (browser), `MemoryStore` (tests/Node). `createStore()` picks the
right one for the environment.

## Dataset JSON schema (`exportDataset(records)`)

Only *resolved* scenarios are emitted (`pending` has no ground truth):

```json
[
  {
    "snapshotId": "…",
    "scenarioId": "wave-3",
    "features": { /* ScenarioFeatures, as above */ },
    "outcome": 1,                       // 1 = target-hit, 0 = invalidated
    "resolver": "auto"                  // or 'human'
  }
]
```

## How the resolver orders target-vs-invalidation

`resolveSnapshot(snapshot, laterCandles)` decides each scenario **objectively**:

1. Discard candles at/before `snapshot.ts`; sort the rest oldest → newest.
2. Build the scenario's **target zone** = the min..max span of its target prices.
   The trigger edge is the *near* edge in the bias direction (the low edge for an
   up scenario, the high edge for a down scenario) — entering the zone counts.
3. The **invalidation** sits opposite the bias direction.
4. Walk candles in **chronological order**. For each candle check whether its
   range reached the target edge (up: `high >= edge`; down: `low <= edge`) or the
   invalidation (up: `low <= inval`; down: `high >= inval`).
   - First candle to reach **only the target** → `target-hit`.
   - First candle to reach **only the invalidation** → `invalidated`.
   - A **single candle that straddles both** (a wide bar spanning both levels):
     resolved as `invalidated` — risk is conservatively treated as realized
     before reward, and the case is flagged in `reason` for human override.
   - If neither is reached by the last candle → `pending`.
5. Every auto-decision is tagged `resolver: 'auto'`. Whichever level is reached
   *first chronologically* wins; we never look past the deciding candle.

Human review (`review.html`) only overrides ambiguous/pending cases; overrides are
tagged `resolver: 'human'` and the auto-resolver will not clobber them on re-run.

## Calibration scaffold (NOT ML)

`calibrate(dataset)` fits a **1-D, interpretable** logistic reliability curve
mapping raw model confidence → empirical hit rate (plus an isotonic-style
reliability table for diagnostics). It is **not** a classifier over the full
feature vector, by design. `applyCalibration(model, raw)` returns `raw`
**unchanged** until at least `MIN_SAMPLES` (currently **30**) resolved examples
exist — too little data cannot calibrate anything. Until then, the UI keeps
labeling probabilities "model-derived confidence", consistent with the README.
