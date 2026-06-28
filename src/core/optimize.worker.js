// ① Web Worker wrapper around the param sweep, so a large/deep optimisation
// never blocks the UI. The page posts { series, gridSpec, opts }; we post back
// { ok, result } or { ok:false, error }. Module worker — imports the pure core.

import { optimize } from './optimize.js';

self.onmessage = (e) => {
  const { series, gridSpec, opts } = e.data ?? {};
  try {
    const result = optimize(series, gridSpec, opts);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
};
