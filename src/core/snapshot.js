// Phase 6e — snapshot capture, evaluation, metrics, feedback (spec §P.9).
//
// A Snapshot is a frozen record of the predictive engine's output at a given
// moment in time.  It can later be evaluated against the price that actually
// materialised, enabling accuracy tracking and human-in-the-loop correction.
//
// Lifecycle:
//   takeSnapshot() → Snapshot { outcome: null }   (pending)
//   evaluateSnapshot(snap, price) → Snapshot { outcome: 'hit'|'miss'|'pending' }
//   recordFeedback(snap, outcome) → Snapshot { outcome, feedback }
//   computeMetrics([snaps]) → { total, hit, miss, expired, pending, accuracy }
//   replayHistory([{snap,price}]) → Snapshot[]   (historical batch evaluation)
//
// All functions are pure (no mutable global state) to make them easy to test
// and to compose with any persistence layer.

// ── takeSnapshot ──────────────────────────────────────────────────────────────
//
// Freezes the current hypothesis list into a snapshot.
// hypotheses: output of enumerateHypotheses / rankAndBeam / compose
// opts: { id, timestamp }

export function takeSnapshot(hypotheses, livePrice, opts = {}) {
  return {
    id:          opts.id        ?? `snap_${livePrice}_${opts.timestamp ?? Date.now()}`,
    timestamp:   opts.timestamp ?? Date.now(),
    livePrice,
    hypotheses:  hypotheses.map(shallowClone),
    outcome:     null,
    feedback:    null,
  };
}

// ── evaluateSnapshot ──────────────────────────────────────────────────────────
//
// Compares `currentPrice` against each hypothesis's TP zone and hard
// invalidation level.
//
// Resolution rules (applied to all hypotheses, first-wins):
//   'hit'     — currentPrice is inside any hypothesis's TP zone
//   'miss'    — currentPrice has crossed every hypothesis's hard invalidation
//   'pending' — neither condition is met yet

export function evaluateSnapshot(snapshot, currentPrice) {
  if (currentPrice == null) return { ...snapshot };

  const outcomes = snapshot.hypotheses.map(h => classifyPrice(h, currentPrice));

  let outcome;
  if (outcomes.includes('hit'))              outcome = 'hit';
  else if (outcomes.every(o => o === 'miss')) outcome = 'miss';
  else                                        outcome = 'pending';

  return { ...snapshot, outcome };
}

// ── recordFeedback ────────────────────────────────────────────────────────────
//
// Human-in-the-loop override: manually assign an outcome and optional notes.

export function recordFeedback(snapshot, outcome, notes = '') {
  return {
    ...snapshot,
    outcome,
    feedback: { outcome, notes, timestamp: Date.now() },
  };
}

// ── computeMetrics ────────────────────────────────────────────────────────────
//
// Aggregates a list of evaluated snapshots into accuracy metrics.
//
// accuracy = hit / (hit + miss + expired)
// null when no closed scenarios exist yet.

export function computeMetrics(snapshots) {
  let hit = 0, miss = 0, expired = 0, pending = 0;

  for (const s of snapshots) {
    if      (s.outcome === 'hit')     hit++;
    else if (s.outcome === 'miss')    miss++;
    else if (s.outcome === 'expired') expired++;
    else                              pending++;  // null or 'pending'
  }

  const closed   = hit + miss + expired;
  const accuracy = closed > 0 ? hit / closed : null;

  return {
    total: snapshots.length,
    hit, miss, expired, pending,
    accuracy,
  };
}

// ── replayHistory ─────────────────────────────────────────────────────────────
//
// Batch-evaluates a sequence of historical snapshots.
// entries: Array<{ snapshot: Snapshot, outcomePrice: number|null }>
// Returns an Array<Snapshot> with outcomes set.

export function replayHistory(entries) {
  return entries.map(({ snapshot, outcomePrice }) =>
    evaluateSnapshot(snapshot, outcomePrice ?? null),
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function classifyPrice(hyp, price) {
  const tp    = hyp.zones?.tp;
  const inval = hyp.zones?.invalidation?.hard_1deg;

  // TP zone hit check
  if (tp) {
    const [tpLo, tpHi] = tp;
    if (price >= tpLo && price <= tpHi) return 'hit';
  }

  // Hard invalidation cross check
  if (inval != null) {
    const crossed = hyp.bias === 'bull'
      ? price > inval    // bull flat: killed when price rises above 1°
      : price < inval;   // bear flat: killed when price falls below 1°
    if (crossed) return 'miss';
  }

  return 'pending';
}

function shallowClone(h) {
  return {
    ...h,
    anchor:     h.anchor     ? { ...h.anchor }     : h.anchor,
    zones:      h.zones      ? { ...h.zones }      : h.zones,
    confidence: h.confidence ? { ...h.confidence } : h.confidence,
  };
}
