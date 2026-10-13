package main

import (
	"encoding/json"
	"math"
	"path/filepath"
	"testing"
)

func TestRequestTPS(t *testing.T) {
	cases := []struct {
		name          string
		output        int64
		latency, ttft float64
		failed        bool
		want          float64
	}{
		{"with_ttft", 100, 2500, 500, false, 50},
		{"without_ttft", 100, 2500, 0, false, 40},
		{"sub_millisecond", 100, 0.5, 0.25, false, 400000},
		{"failed", 100, 2500, 500, true, 0},
		{"no_output", 0, 2500, 500, false, 0},
		{"negative_output", -1, 2500, 500, false, 0},
		{"no_latency", 100, 0, 0, false, 0},
		{"negative_latency", 100, -1, 0, false, 0},
		{"negative_ttft", 100, 2500, -1, false, 0},
		{"ttft_equals_latency", 100, 2500, 2500, false, 0},
		{"ttft_exceeds_latency", 100, 2500, 3000, false, 0},
		{"nan_latency", 100, math.NaN(), 0, false, 0},
		{"infinite_latency", 100, math.Inf(1), 0, false, 0},
		{"nan_ttft", 100, 2500, math.NaN(), false, 0},
		{"infinite_ttft", 100, 2500, math.Inf(1), false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := requestTPS(tc.output, tc.latency, tc.ttft, tc.failed)
			if tc.want == 0 {
				if got != nil {
					t.Fatalf("want nil, got %v", *got)
				}
			} else if got == nil || *got != tc.want {
				t.Fatalf("want %v, got %v", tc.want, got)
			}
		})
	}
}

func TestPerformanceAPI(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "performance.sqlite"))
	for _, record := range []string{
		`{"Model":"stream","RequestedAt":"2026-09-10T11:30:00Z","Latency":2500000000,"TTFT":500000000,"Detail":{"OutputTokens":100,"ReasoningTokens":80}}`,
		`{"Model":"no-ttft","RequestedAt":"2026-09-10T11:30:01Z","Latency":2500000000,"Detail":{"OutputTokens":100}}`,
		`{"Model":"failed","RequestedAt":"2026-09-10T11:30:02Z","Latency":2500000000,"TTFT":500000000,"Failed":true,"Detail":{"OutputTokens":100}}`,
		`{"Model":"legacy","RequestedAt":"2026-09-10T11:30:03Z","Detail":{"OutputTokens":100}}`,
		`{"Model":"invalid","RequestedAt":"2026-09-10T11:30:04Z","Latency":1000000000,"TTFT":2000000000,"Detail":{"OutputTokens":100}}`,
	} {
		handleUsage([]byte(record))
	}
	status, _, body := callMgmt(t, "/v0/management/plugins/usage-report/api/usage", "GET")
	if status != 200 {
		t.Fatalf("HTTP %d: %s", status, body)
	}
	var response struct {
		Events []outEvent `json:"events"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Events) != 5 {
		t.Fatalf("unexpected response: %s", body)
	}
	for _, e := range response.Events {
		switch e.Model {
		case "stream":
			if e.LatencyMs != 2500 || e.TTFTMs != 500 || e.TPS == nil || *e.TPS != 50 {
				t.Fatalf("incorrect streaming performance: %+v", e)
			}
		case "no-ttft":
			if e.TPS == nil || *e.TPS != 40 {
				t.Fatalf("incorrect fallback: %+v", e)
			}
		default:
			if e.TPS != nil {
				t.Fatalf("invalid event has TPS: %+v", e)
			}
		}
	}
	// Querying historical payloads must not backfill derived fields into storage.
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage_events WHERE payload LIKE '%\"tps\"%'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("query modified stored payloads")
	}
}
