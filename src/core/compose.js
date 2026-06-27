// Phase 6d: vertical recursion + horizontal chaining (spec §P.6).
//
// Each leg of a higher-TF flat is itself a flat at a lower TF (vertical).
// After a flat completes, the next flat can start at C (horizontal chain).
//
// Guards prevent unbounded recursion:
//   MAX_DEPTH — vertical nesting levels
//   MAX_CHAIN — consecutive flats in a horizontal chain
//   TF_FLOOR  — minimum pivots needed to attempt hypothesis enumeration
//   beam      — max scenarios per level (from predict.js)
//
// Confidence pruning: when a node's confidence falls below pruneThreshold,
// recursion stops for that branch (avoids exploring noise).

import { enumerateHypotheses, rankAndBeam } from './predict.js';
import { applyFractalConstraints }            from './fractal.js';

export const MAX_DEPTH    = 3;
export const MAX_CHAIN    = 3;
export const TF_FLOOR     = 4;   // O + 2 internal sub-pivots + endpoint = 4 minimum
export const DEFAULT_BEAM = 4;

// ── compose — main entry point ────────────────────────────────────────────────
//
// Returns an array of ComposedNode (at most `beam` root nodes), each with:
//   hyp        — the Hypothesis at this node
//   depth      — vertical recursion depth (root = 0)
//   chainIdx   — horizontal chain position (root = 0)
//   legs       — { A, B, C }: sub-flat ComposedNode|null for each confirmed leg
//   next       — next flat in chain (horizontal), ComposedNode|null
//   confidence — hyp.confidence.value (for quick access)
//
// opts:
//   maxDepth       (3)    — max vertical recursion depth
//   maxChain       (3)    — max horizontal chain length
//   tfFloor        (4)    — min pivots to enumerate
//   beam           (4)    — max hypotheses per level
//   pruneThreshold (0.05) — stop recursing below this confidence
//   subPivots      (null) — finer-grained pivot array for vertical recursion;
//                           falls back to the same `pivots` when null
//   goal           (null) — optional higher-TF goal for top-level constraints

export function compose(pivots, livePrice, opts = {}) {
  if (!pivots || pivots.length < TF_FLOOR) return [];

  const cfg = buildCfg(opts);

  let hyps = enumerateHypotheses(pivots, livePrice, opts);

  // Apply optional higher-TF constraints before ranking
  if (cfg.goal) {
    const { kept } = applyFractalConstraints(hyps, cfg.goal);
    hyps = kept;
  }

  const ranked = rankAndBeam(hyps, cfg.beam);
  return ranked.map(h => buildNode(h, pivots, livePrice, 0, 0, cfg));
}

// ── Internal tree builder ────────────────────────────────────────────────────

function buildNode(hyp, pivots, livePrice, depth, chainIdx, cfg) {
  const node = {
    hyp,
    depth,
    chainIdx,
    legs:       { A: null, B: null, C: null },
    next:       null,
    confidence: hyp.confidence.value,
  };

  // Pruning: do not recurse into low-confidence branches
  if (hyp.confidence.value < cfg.pruneThreshold) return node;

  // ── Vertical recursion ────────────────────────────────────────────────────
  if (depth < cfg.maxDepth) {
    const src         = cfg.subPivots ?? pivots;
    const { O, A, B, C } = hyp.anchor;

    if (O && A) {
      node.legs.A = buildSubLeg(src, O, A, hyp, A.price, depth, chainIdx, cfg);
    }
    if (A && B) {
      node.legs.B = buildSubLeg(src, A, B, hyp, B.price, depth, chainIdx, cfg);
    }
    if (B && C) {
      node.legs.C = buildSubLeg(src, B, C, hyp, C.price, depth, chainIdx, cfg);
    }
  }

  // ── Horizontal chaining ───────────────────────────────────────────────────
  if (chainIdx < cfg.maxChain) {
    const C = hyp.anchor.C;
    if (C) {
      // Pivots at C.time or later form the substrate of the next flat
      const postC = pivots.filter(p => p.time >= C.time);
      if (postC.length >= cfg.tfFloor) {
        const chainHyps = enumerateHypotheses(postC, livePrice);
        const { kept }  = applyFractalConstraints(chainHyps, cfg.goal ?? null);
        const best      = rankAndBeam(kept, 1)[0];
        if (best) {
          node.next = buildNode(best, postC, livePrice, depth, chainIdx + 1, cfg);
        }
      }
    }
  }

  return node;
}

// Build a sub-flat within one leg (from → to) using pivots from `src`.
function buildSubLeg(src, from, to, parentHyp, legLivePrice, depth, chainIdx, cfg) {
  if (!from || !to) return null;

  const inner = src.filter(p => p.time > from.time && p.time < to.time);
  const legPivots = [from, ...inner, to];
  if (legPivots.length < cfg.tfFloor) return null;

  const subHyps  = enumerateHypotheses(legPivots, legLivePrice);
  // Parent hyp serves as the higher-TF goal: sub-flats must not cross its
  // hard invalidation level, and concordant ones are boosted.
  const { kept } = applyFractalConstraints(subHyps, parentHyp);
  const best     = rankAndBeam(kept, 1)[0];
  if (!best) return null;

  return buildNode(best, legPivots, legLivePrice, depth + 1, chainIdx, cfg);
}

// ── Utilities ────────────────────────────────────────────────────────────────

// Flatten a composed tree (or array of trees) into a depth-first list of nodes.
export function flattenComposed(nodes) {
  const result = [];
  const visit  = (node) => {
    if (!node) return;
    result.push(node);
    visit(node.legs.A);
    visit(node.legs.B);
    visit(node.legs.C);
    visit(node.next);
  };
  const roots = Array.isArray(nodes) ? nodes : [nodes];
  for (const n of roots) visit(n);
  return result;
}

function buildCfg(opts) {
  return {
    maxDepth:       opts.maxDepth       ?? MAX_DEPTH,
    maxChain:       opts.maxChain       ?? MAX_CHAIN,
    tfFloor:        opts.tfFloor        ?? TF_FLOOR,
    beam:           opts.beam           ?? DEFAULT_BEAM,
    pruneThreshold: opts.pruneThreshold ?? 0.05,
    subPivots:      opts.subPivots      ?? null,
    goal:           opts.goal           ?? null,
  };
}
