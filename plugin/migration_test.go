package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func usageForDateRange(t *testing.T, start, end string) ([]outEvent, []outEvent) {
	t.Helper()
	body, err := usageResponse(map[string][]string{
		"start": {start}, "end": {end}, "bucket": {"day"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Events      []outEvent `json:"events"`
		QuotaEvents []outEvent `json:"quota_events"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode: %v body=%s", err, body)
	}
	return response.Events, response.QuotaEvents
}

func addUsageRecord(t *testing.T, at time.Time, source, model string, quota bool) {
	t.Helper()
	record := usageRecord{
		Provider: "codex", Model: model, Source: source, RequestedAt: at,
		ResponseModel: model, AuthID: "account-" + source,
	}
	if quota {
		record.ResponseHeaders = quotaHeaders(time.Now())
	}
	record.Detail.InputTokens = 1000
	record.Detail.OutputTokens = 100
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	handleUsage(raw)
}

func TestLegacyDatabaseMigratesTimestampsAndModelIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec("CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, dedup TEXT UNIQUE, payload TEXT)"); err != nil {
		t.Fatal(err)
	}
	payload := `{"timestamp":"2026-09-10T11:30:00+08:00","model":"gpt-6.1-sol","provider":"codex","source":"legacy","tokens":{"input_tokens":1000,"output_tokens":100}}`
	if _, err := legacy.Exec("INSERT INTO usage_events (ts, dedup, payload) VALUES (?,?,?)", "2026-09-10 11:30:00", "legacy-dedup", payload); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	openDB(path)
	var tsUnix int64
	if err := db.QueryRow("SELECT ts_unix FROM usage_events WHERE dedup='legacy-dedup'").Scan(&tsUnix); err != nil {
		t.Fatal(err)
	}
	wantTime, err := time.Parse(time.RFC3339, "2026-09-10T11:30:00+08:00")
	if err != nil {
		t.Fatal(err)
	}
	if tsUnix != wantTime.Unix() {
		t.Fatalf("ts_unix=%d, want %d", tsUnix, wantTime.Unix())
	}
	var index string
	if err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_events_ts_unix'").Scan(&index); err != nil {
		t.Fatalf("timestamp index missing: %v", err)
	}
	planRows, err := db.Query(`EXPLAIN QUERY PLAN SELECT ts_unix, payload FROM usage_events
		WHERE (ts_unix >= 1 AND ts_unix < 2) OR (ts_unix >= 1 AND ts_unix <= 2)
		ORDER BY ts_unix, id`)
	if err != nil {
		t.Fatal(err)
	}
	var plan strings.Builder
	for planRows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := planRows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			planRows.Close()
			t.Fatal(err)
		}
		plan.WriteString(detail + "\n")
	}
	planRows.Close()
	if !strings.Contains(plan.String(), "idx_usage_events_ts_unix") || strings.Contains(plan.String(), "SCAN usage_events") {
		t.Fatalf("range query does not use the timestamp index:\n%s", plan.String())
	}
	var modelCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage_models WHERE provider='codex' AND model='gpt-6.1-sol'").Scan(&modelCount); err != nil || modelCount != 1 {
		t.Fatalf("model index backfill failed: count=%d err=%v", modelCount, err)
	}
	events, _ := usageForDateRange(t, "2026-09-10", "2026-09-10")
	if len(events) != 1 || events[0].Model != "gpt-6.1-sol" {
		t.Fatalf("legacy event missing after migration: %+v", events)
	}
	pricing, err := pricingResponse()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(pricing), "gpt-6.1-sol") {
		t.Fatalf("price table did not use model index: %s", pricing)
	}
}

func TestUsageQueryReadsOnlySelectedRangeAndRecentQuotaHistory(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "range.sqlite"))
	now := time.Now()
	addUsageRecord(t, now.AddDate(0, 0, -60), "old", "gpt-6.1-sol", true)
	addUsageRecord(t, now.AddDate(0, 0, -10), "quota", "gpt-5.6-terra", true)
	addUsageRecord(t, now, "today", "gpt-6-luna", true)
	today := now.Format("2006-01-02")
	events, quotaEvents := usageForDateRange(t, today, today)
	if len(events) != 1 || events[0].Model != "gpt-6-luna" {
		t.Fatalf("selected range returned wrong events: %+v", events)
	}
	if len(quotaEvents) != 2 {
		t.Fatalf("quota history should contain only the last 30 days, got %d", len(quotaEvents))
	}
	seen := map[string]bool{}
	for _, e := range quotaEvents {
		if seen[e.Model] {
			t.Fatalf("overlapping ranges processed %s twice", e.Model)
		}
		seen[e.Model] = true
	}
	if !seen["gpt-5.6-terra"] || !seen["gpt-6-luna"] || seen["gpt-6.1-sol"] {
		t.Fatalf("unexpected quota history: %+v", seen)
	}

	// Expanding the selected range overlaps quota history but still yields one
	// event per row.
	start := now.AddDate(0, 0, -10).Format("2006-01-02")
	events, quotaEvents = usageForDateRange(t, start, today)
	if len(events) != 2 || len(quotaEvents) != 2 {
		t.Fatalf("overlap duplicated rows: events=%d quota=%d", len(events), len(quotaEvents))
	}
	if events[0].Input != 1000 || events[0].Output != 100 {
		t.Fatalf("token totals changed: %+v", events[0])
	}
}

func TestModelIndexTracksRequestedAndResponseModels(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "models.sqlite"))
	addUsageRecord(t, time.Now(), "alias-source", "requested-alias", false)
	record := usageRecord{Provider: "codex", Model: "requested-alias", ResponseModel: "gpt-6-astra", Source: "response-source", RequestedAt: time.Now()}
	raw, _ := json.Marshal(record)
	handleUsage(raw)
	for _, model := range []string{"requested-alias", "gpt-6-astra"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage_models WHERE provider='codex' AND model=?", model).Scan(&count); err != nil || count != 1 {
			t.Fatalf("model index missing %s: count=%d err=%v", model, count, err)
		}
	}
	body, err := pricingResponse()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "requested-alias") || !strings.Contains(string(body), "gpt-6-astra") {
		t.Fatalf("price table index incomplete: %s", body)
	}
}

func TestPriceBookCacheInvalidatesAfterVersionChange(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "price-cache.sqlite"))
	first, err := getPriceBook(db)
	if err != nil {
		t.Fatal(err)
	}
	second, err := getPriceBook(db)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("unchanged price versions should reuse the cached book")
	}
	if err := setCustomPrice([]byte(fmt.Sprintf(`{"model":"cache-test-%d","provider":"codex","price":{"input":1,"output":2}}`, time.Now().UnixNano()))); err != nil {
		t.Fatal(err)
	}
	third, err := getPriceBook(db)
	if err != nil {
		t.Fatal(err)
	}
	if third == first || len(third.versions) != len(first.versions)+1 {
		t.Fatal("price cache was not invalidated after saving a new version")
	}
}
