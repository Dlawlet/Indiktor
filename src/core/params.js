// ① prereq #2 — Provenance: the canonical tunable parameter set + a stable hash.
//
// Every snapshot is tagged with the param config that produced it AND that
// config's hash, so realized outcomes can be attributed to a specific
// configuration — the foundation of the optimisation loop. Without provenance
// there is no outcome→params link and optimisation is impossible.
//
// The hash covers the ENGINE knobs only, NOT the series (asset/tf are the
// "segment", a separate dimension handled by estimate.js). Pure module.

import { BANDS } from './flats.js';

// Defaults mirror the engine's current source-of-truth constants. The UI tunes
// k / minConf / predFloor today; the rest are captured so a future optimiser can
// vary them and still attribute outcomes correctly.
export const DEFAULT_PARAMS = {
  k:            3,      // zigzag ATR multiplier (UI: sensitivity)
  minConf:      0.55,   // detector min confidence (UI)
  predFloor:    0.15,   // prediction display floor (④a)
  beam:         4,      // rankAndBeam width
  mm:           1.0,    // measured-move multiple (predict.js TP)
  breakDelta:   0.10,   // flats DEFAULT_BREAK.delta
  breakBigMult: 2.00,   // flats DEFAULT_BREAK.bigMult
  breakTau:     0.50,   // flats DEFAULT_BREAK.tau
  bRatioLo:     0.382,  // timing B window
  bRatioHi:     1.618,
  cRatioLo:     0.500,  // timing C window
  cRatioHi:     2.000,
  bandsRev:     bandsRevision(), // fingerprint of the prototypicality bands
};

// Compact fingerprint of the BANDS table: if the bands change, the param hash
// changes too (outcomes under the old bands aren't comparable to new ones).
function bandsRevision() {
  return Object.keys(BANDS).sort().map((t) => {
    const b = BANDS[t];
    return `${t}:${b.rB.join(',')};${b.pC.join(',')};${b.lenC.join(',')}`;
  }).join('|');
}

// Merge engine defaults with the active (UI) overrides. Unknown keys are kept so
// nothing silently drops out of provenance.
export function buildParams(overrides = {}) {
  return { ...DEFAULT_PARAMS, ...overrides };
}

// Deterministic FNV-1a 32-bit hash of the key-sorted param set → 8 hex chars.
// Key-sorting makes the hash independent of property insertion order.
export function hashParams(params) {
  const norm = {};
  for (const k of Object.keys(params).sort()) norm[k] = params[k];
  const str = JSON.stringify(norm);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Segment key for partial pooling: TF, optionally narrowed by flat type.
// (estimate.js groups outcomes by segment; the global pool is segment '*'.)
export function segmentKey(tf, type = null) {
  return type ? `${tf}|${type}` : `${tf}`;
}
