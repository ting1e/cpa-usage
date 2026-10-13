# CPA Usage Report (CLIProxyAPI Plugin)

Local-first token usage dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), shipped as a native plugin (`.dylib`/`.so`) running inside the CPA process.

- **Real-time collection**: receives every completed request through the `usage.handle` plugin callback — no polling, no data loss.
- **Embedded dashboard**: the [cpa-usage](https://github.com/andyWang1688/cpa-usage) shadcn/ui frontend is bundled and served under `/v0/resource/plugins/usage-report/report`.
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

This fork's v0.3.5 adds output TPS, request latency and TTFT metrics. When upgrading from the original author's source, replace that source with the URL above, refresh the store, update `usage-report` and restart CPA. Keep the existing `db_path` and SQLite history; ensure its parent directory exists and is writable by the CPA process.

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
