# Changelog

## 0.4.4

- Limit GitHub Actions builds and release artifacts to Linux amd64/arm64. Run essential Go and frontend checks once on Ubuntu, removing macOS runner dependencies and Windows cross-compilation setup.

## 0.4.3

- Load selected-date statistics independently from 30-day Codex quota history so KPI cards no longer wait for the full quota response. Existing API callers retain the combined response by default; `quota=none` and `quota=only` opt into independent loading.
- Add a migrated `(is_codex, ts_unix)` index and skip unrelated records before pricing. Preserve fractional request timestamps for concurrency analysis.
- Abort obsolete date-filter requests, refresh quota independently, and defer collapsed quota-history rendering until expanded.
- Simplify the Codex quota panel by removing duplicate cost totals, verbose explanations and sampling diagnostics while retaining account quotas, reset times, estimates and history.

## 0.4.2

- Add an indexed `ts_unix` column to `usage_events` and backfill legacy rows in bounded batches, so dashboard queries read only the selected date range plus the recent 30-day quota history instead of scanning all history.
- Avoid duplicate processing when the selected range overlaps quota history; only rows that are actually returned are parsed and priced.
- Cache parsed price versions until a new version is written, and replace the price-table full-history JSON scan with a backfilled `usage_models` index maintained on every new request.
- Coalesce overlapping manual, automatic and filter-triggered frontend refreshes so only one `/usage` request runs at a time while keeping 60-second auto refresh.
- Add legacy migration, date filtering, quota-window, model-index and price-cache regression tests.

## 0.4.1

- Rebase the fork on upstream v0.4.0 so the LiteLLM price engine, custom prices, price history, cost trends and USD/CNY display are the single source of truth.
- Merge output TPS, average latency and average TTFT into the v0.4.0 dashboard, model/key aggregates, request details and sorting.
- Capture Codex credential identity and sanitized 5-hour/weekly quota observations; add multi-account quota estimates, remaining/reset snapshots and a recent 30-day history with per-model token/cost detail.
- Support every Codex GPT model and future variants without a model whitelist. Keep the requested model ID, preserve the actual response model, prefer the response model for pricing and fall back to the requested model only.
- Use backend-calculated per-request costs for quota estimates, and aggregate shared Codex account quotas once instead of duplicating them per model.
- Preserve legacy SQLite data, protocol dedup identities and unknown-model unpriced behavior; add GPT variant, response-model fallback, shared-account quota and performance regression tests.
- Fix management-panel “remember password” compatibility for CPAMC v1.27.0+ by supporting both CPAMC v1 (host + user agent) and v2 (host only) secure-storage formats while retaining plaintext JSON compatibility.

## 0.4.0

- Add estimated token costs to the dashboard, trends, and model/key/request details (#17). Show pricing coverage and distinguish unpriced requests from zero cost.
- Bundle LiteLLM text-model prices, support automatic and manual updates, provider-specific custom rates, and versioned historical estimates. Failed updates retain local prices and show a friendly message.
- Support USD/CNY display with an editable exchange rate. Show currency symbols beside table prices and currency/token units on price columns and edit fields.
- Document token-estimation limits and proxy environment variables for public price updates.

## 0.3.6

- Capture CPA 8.x Codex credential identity and sanitized 5-hour/weekly quota observations without storing arbitrary response headers or changing existing dedup identities.
- Estimate per-account/model/tier quota capacity and USD equivalents from adjacent serial CPA activity; exclude idle gaps, resets, failures and ambiguous samples.
- Add editable model API-equivalent USD prices, partial/unpriced coverage and request/model/key cost details.

## 0.3.5

- Add output TPS, average request latency, and average time to first token (TTFT) to the dashboard and model/key/request detail views.
- Calculate aggregate TPS from total eligible output tokens and generation duration; exclude failed requests and invalid timing samples, and preserve historical data without migration.
- Publish this fork's plugin store registry and release artifacts under `ting1e/cpa-usage`.

## 0.3.4

- Fix Claude input and total tokens to include cache reads and creation; cache creation no longer counts as a cache hit (#14).
- Preserve provider/executor identity for new events and avoid double-counting OpenAI-compatible or Gemini input. Historical rows without protocol identity are corrected only when the counters disambiguate the input convention; ambiguous rows retain their original input. No database migration or rewrite of stored counters is required.
- Inject the release version into the plugin binary so registration and usage APIs report the published version.

## 0.3.3

- Extract the sliding segmented control into a shared component; the hour/day/month switcher now slides like the range picker (it was an instant swap before).
- Speed up chart animations (450ms, ease-out).

## 0.3.2

- Enable the shadcn animation layer (`tw-animate-css`) so existing `animate-in` / `fade-in` / `slide-in` classes actually work; re-enable chart animations (recharts was hard-disabled) and add light staggered entrance animations for the metric grid, chart and detail cards.

## 0.3.1

- Dashboard now reuses the CPA management panel session (same-origin secure storage, the standard approach used by CPA plugins) instead of asking for the management key. When the session is unavailable it shows guidance to log in to the management center with "remember password" enabled.

## 0.3.0

- **Plugin store compliance**: dynamic API endpoints (`/api/usage`, `/api/health`, `/api/collect`) now register as authenticated management routes under `/v0/management/plugins/usage-report/api/...` instead of the unauthenticated `/v0/resource/plugins/...` prefix. The dashboard asks for the CPA management key on first use and stores it in the browser (localStorage).
- Release builds now cover all five plugin-store platforms: darwin arm64/amd64, linux amd64/arm64, windows amd64.

## 0.2.3

- fix: plugin configuration (`db_path`) was never applied when the host delivered the payload wrapped in a `result` envelope; the plugin silently fell back to its built-in default path. Both payload shapes are now handled, and the default path is `~/.cli-proxy-api/usage-report.sqlite`.

## 0.2.2

- Dashboard "更新于" (updated at) now reflects the freshness timestamp of each refresh instead of the last received request time, so it no longer looks frozen during idle periods.

## 0.2.1

- Dashboard: drop the obsolete standalone-service settings dialog, the "sync usage" button and the terminal setup notice; the page auto-refreshes and the footer shows the plugin version.
- Frontend: build with `base: "./"` and relative API paths so assets resolve from the plugin resource route.
- Release: the plugin version is injected at build time (`-ldflags -X main.version=$VERSION`).

## 0.2.0

- Rework the project into a CLIProxyAPI native plugin (`plugin/`): usage collected in real time via the `usage.handle` callback; dashboard and data API served inside the CPA process via `management_api`.
- Publish installable releases through the plugin store (`plugin-store/registry.json`); one-click install from the CPA management panel.
- Automated multi-platform plugin builds on tag (darwin/arm64, linux/amd64, linux/arm64) with `checksums.txt`.
- Dashboard assets are built from `frontend/` and embedded into the plugin.
- Remove the former standalone Python service (`report.py`, `cli.py`, `install.sh` and related tests/scripts); the plugin replaces it.

## 0.1.1

- Default application home is now `~/.cpa-usage/`.
- Add `cpa-usage migrate` for legacy installations, preserving configuration, SQLite history, logs and versions; rebuild the virtual environment and restart safely.
- Refuse existing migration targets, preserve custom directories and external databases, and restore the old service on failed startup.
- Emphasize local-first storage and lightweight, single-process operation in the dashboard and documentation.

## 0.1.0

- Real shadcn/ui dashboard with calendar ranges, stacked trend, model filtering and anonymized key/request tables.
- Local SQLite collector; fix out-of-order buckets, inclusive end dates, zero-token request counts and hidden collector errors.
- Versioned, checksummed release installation and command-line service management.
- Update preserves configuration/database and rolls back the program on failed startup.
- Automated tests and prebuilt releases on macOS/Linux CI.
