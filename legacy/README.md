# Legacy — macro indicator dashboards (archived 2026-06)

These are the pre-pivot files, kept for reference and to reuse the email-alert harness.
They are **not** part of the new Elliott Wave app.

- `index.html`, `eth.html` — old BTC/ETH macro-indicator scoreboards.
- `scripts/score-monitor.js` — cron job that recomputed indicator scores and emailed on
  large moves.
- `workflows/score-monitor.yml` — the GitHub Actions schedule for the above. Moving it
  out of `.github/workflows/` disables it; restore the path to re-enable.

See the project memory for why we pivoted.
