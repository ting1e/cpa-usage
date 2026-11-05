# CPA Usage Report (CLIProxyAPI Plugin)

Local-first token usage dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), shipped as a native plugin (`.dylib`/`.so`) running inside the CPA process.

- **Real-time collection**: receives every completed request through the `usage.handle` plugin callback — no polling, no data loss.
- **Embedded dashboard**: the [cpa-usage](https://github.com/ting1e/cpa-usage) shadcn/ui frontend is bundled and served under `/v0/resource/plugins/usage-report/report`.
- **SQLite storage**: usage events are stored locally in `usage.sqlite`.

## Install via CPA Plugin Store

Add this registry to `cliproxyapi.conf`:

```yaml
plugins:
  enabled: true
  store-sources:
     - "https://raw.githubusercontent.com/ting1e/cpa-usage/main/plugin-store/registry.json"
  configs:
    usage-report:
      enabled: true
      db_path: "~/.cli-proxy-api/usage-report/usage.sqlite"
```

Then install from the management panel: **Plugin Store → CPA Usage Report → Install**.

This fork's v0.4.2 is based on upstream v0.4.0. It includes the upstream LiteLLM price engine, custom prices, price versions, cost trends and USD/CNY display, plus output TPS, request latency, TTFT, and multi-account Codex quota estimates/history (CPA 8.x required). All Codex GPT models and future variants are recorded without a model whitelist; response models are priced first with the requested model as fallback. The dashboard reads CPAMC v1, CPAMC v2 (v1.27.0+, host-only storage key) and plaintext saved management sessions. When upgrading from the original author's source, replace that source with the URL above, refresh the store, update `usage-report` and restart CPA. Keep the existing `db_path` and SQLite history; ensure its parent directory exists and is writable by the CPA process. Codex quota headers are account-wide, so shared quotas are counted once per account/window; snapshots cannot distinguish external Codex use concurrent with CPA activity.

## Manual install

```bash
go build -buildmode=c-shared -o usage-report.dylib .
mkdir -p <plugins-dir>/<goos>/<goarch>
cp usage-report.dylib <plugins-dir>/<goos>/<goarch>/
```

## Dashboard

- Page: `/v0/resource/plugins/usage-report/report`
- API (management authentication required): `/v0/management/plugins/usage-report/api/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&bucket=day|hour|month`

## Frontend assets

The files in `web/` are the build output of this repository's `frontend/` directory:

```sh
cd frontend && npm ci && npm run build
cp dist/index.html ../plugin/web/index.html
cp dist/assets/* ../plugin/web/assets/
```

After replacing assets, update the embedded file names and resource routes in `main.go` (build output uses hashed file names).

## License

MIT. The bundled dashboard assets (`web/`) come from this repository's `frontend/` sources (MIT).
