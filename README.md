# Indiktor

## Score change email monitor

A scheduled GitHub Actions workflow (`.github/workflows/score-monitor.yml`) runs every 8 hours (and on manual dispatch) to:

- Recompute BTC and ETH overall **short-term** and **long-term** scores using the same logic as the dashboards.
- Compare each score to the previous snapshot and flag any relative move of ~10% or more (up or down).
- Email an alert to `winercoiner@gmail.com` when a qualifying move is found.

State is stored in the reusable workflow artifact `score-state` so each run can compare against the prior snapshot (no repository commits are made).

### Configure email sending

Provide SMTP credentials as repository secrets before the workflow can send mail:

- `ALERT_SMTP_SERVER`
- `ALERT_SMTP_PORT`
- `ALERT_SMTP_USERNAME`
- `ALERT_SMTP_PASSWORD`
- `ALERT_FROM_ADDRESS`

Optional: set `THRESHOLD` (e.g. `0.1` for 10%) or `STATE_PATH` in the workflow if you want to adjust defaults.

### Send a test email

Trigger the **Score monitor** workflow manually and set the `test_email` input to `true`. The run will skip data fetching and state updates, and immediately send a test message (customize with `test_email_subject`/`test_email_body`). This is useful for verifying SMTP credentials without waiting for a threshold breach.
