package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func quotaHeaders(now time.Time) map[string][]string {
	return map[string][]string{
		"x-codex-primary-used-percent":          {"20"},
		"X-Codex-Primary-Window-Minutes":        {"300"},
		"x-codex-primary-reset-after-seconds":   {"1000"},
		"x-codex-secondary-used-percent":        {"30"},
		"x-codex-secondary-window-minutes":      {"10080"},
		"x-codex-secondary-reset-after-seconds": {"10000"},
		"x-codex-plan-type":                     {"plus"},
		"Authorization":                         {"Bearer upstream-secret"},
		"Set-Cookie":                            {"private-cookie"},
	}
}

func TestParseQuota(t *testing.T) {
	now := time.Now()
	q := parseCodexQuota(quotaHeaders(now), now)
	if q == nil || q.FiveHour == nil || q.Week == nil || q.Plan != "plus" || q.FiveHour.UsedPercent != 20 || q.Week.ResetAt != now.Unix()+10000 {
		t.Fatalf("bad parsed quota: %+v", q)
	}
	// Never assume primary is 5h: identify by the actual window duration.
	headers := quotaHeaders(now)
	headers["X-Codex-Primary-Window-Minutes"] = []string{"10080"}
	headers["x-codex-secondary-window-minutes"] = []string{"300"}
	headers["x-codex-secondary-reset-after-seconds"] = []string{"1000"}
	q = parseCodexQuota(headers, now)
	if q.Week.UsedPercent != 20 || q.FiveHour.UsedPercent != 30 {
		t.Fatal("swapped windows misidentified")
	}
	for _, value := range []string{"NaN", "+Inf", "-1", "101", "bad", ""} {
		headers := quotaHeaders(now)
		headers["x-codex-primary-used-percent"] = []string{value}
		if q := parseCodexQuota(headers, now); q.FiveHour != nil {
			t.Fatalf("accepted invalid percent %q", value)
		}
	}
	headers = quotaHeaders(now)
	headers["x-codex-primary-reset-after-seconds"] = []string{"-1"}
	headers["x-codex-secondary-reset-after-seconds"] = []string{"999999999999999"}
	if parseCodexQuota(headers, now) != nil {
		t.Fatal("accepted invalid reset")
	}
	if parseCodexQuota(nil, now) != nil {
		t.Fatal("invented quota for missing headers")
	}
}

func TestQuotaCaptureAndAPI(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "quota.sqlite"))
	now := time.Now().Add(-time.Minute)
	record := usageRecord{Provider: "codex", Model: "gpt-6.1-sol", AuthID: "private-auth-id", AuthType: "oauth", RequestID: "test-request", RequestedAt: now, ResponseHeaders: quotaHeaders(time.Now())}
	record.Detail.InputTokens = 100
	record.Detail.OutputTokens = 20
	req, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	handleUsage(req)
	// Retransmission must stay deduplicated despite a different observed_at.
	handleUsage(req)
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage_events").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("dedup failed, got %d", count)
	}
	var payload string
	if err := db.QueryRow("SELECT payload FROM usage_events").Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "upstream-secret") || strings.Contains(payload, "private-cookie") {
		t.Fatal("saved sensitive response headers")
	}
	// The independent quota series still includes recent events with an old UI date range.
	status, _, body := callMgmt(t, "/v0/management/plugins/usage-report/api/usage", "GET")
	if status != 200 {
		t.Fatalf("HTTP %d: %s", status, body)
	}
	if strings.Contains(string(body), "private-auth-id") {
		t.Fatal("raw account identity leaked")
	}
	var response struct {
		QuotaEvents []outEvent `json:"quota_events"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.QuotaEvents) != 1 {
		t.Fatalf("missing independent quota series: %s", body)
	}
	e := response.QuotaEvents[0]
	if !strings.HasPrefix(e.Account, "account-") || e.ObservedTs <= 0 || e.Quota == nil || e.Quota.FiveHour.UsedPercent != 20 {
		t.Fatalf("incorrect quota event: %+v", e)
	}
}

func TestHistoricalQuotaDataRemainsUnknown(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "legacy-quota.sqlite"))
	now := time.Now().Add(-time.Minute)
	payload, err := json.Marshal(map[string]any{
		"timestamp": now.Format(time.RFC3339Nano), "model": "gpt-6.1-sol", "provider": "codex",
		"source": "client-key-not-account", "tokens": map[string]int64{"input_tokens": 100, "output_tokens": 20},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO usage_events (ts, payload) VALUES (?,?)", now.Format("2006-01-02 15:04:05"), string(payload)); err != nil {
		t.Fatal(err)
	}
	body, err := usageResponse(nil)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		QuotaEvents []outEvent `json:"quota_events"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.QuotaEvents) != 1 {
		t.Fatalf("missing historical event: %s", body)
	}
	e := response.QuotaEvents[0]
	if e.Account != "" || e.Quota != nil || e.ObservedTs != 0 {
		t.Fatalf("invented historical quota data: %+v", e)
	}
	var after string
	if err := db.QueryRow("SELECT payload FROM usage_events").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != string(payload) {
		t.Fatal("historical query rewrote storage")
	}
}
