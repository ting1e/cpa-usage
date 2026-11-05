package main

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"testing"
	"time"
)

func usageEventBody(model, responseModel string, ts time.Time) []byte {
	return []byte(fmt.Sprintf(`{"result":{"Provider":"codex","Model":%q,"ResponseModel":%q,"Source":"sk-compat-%s","RequestedAt":%q,"Latency":2500000000,"TTFT":500000000,"Detail":{"InputTokens":1000,"OutputTokens":100}}}`, model, responseModel, responseModel, ts.Format(time.RFC3339Nano)))
}

func currentUsageAPI(t *testing.T) ([]outEvent, []outEvent) {
	t.Helper()
	start := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	end := time.Now().Format("2006-01-02")
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

func TestAllCodexGPTModelVariantsAreRecordedAndPriced(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "variants.sqlite"))
	known := []string{"gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-astra"}
	now := time.Now()
	for _, model := range known {
		handleUsage(usageEventBody(model, model, now))
	}
	// A model added after this release must still be recorded without a code
	// change; it simply remains explicitly unpriced until a price is available.
	handleUsage(usageEventBody("gpt-7-orion", "gpt-7-orion", now))
	events, _ := currentUsageAPI(t)
	if len(events) != len(known)+1 {
		t.Fatalf("want %d events, got %d", len(known)+1, len(events))
	}
	seen := map[string]bool{}
	for _, e := range events {
		seen[e.Model] = true
		if e.TPS == nil || *e.TPS != 50 {
			t.Fatalf("%s missing unified performance metric: %+v", e.Model, e)
		}
		if e.Model == "gpt-7-orion" {
			if e.Cost != nil {
				t.Fatalf("unknown future model must stay unpriced: %+v", e)
			}
		} else if e.Cost == nil {
			t.Fatalf("known GPT model %s should use the shared price engine", e.Model)
		}
	}
	for _, model := range append(known, "gpt-7-orion") {
		if !seen[model] {
			t.Fatalf("model %s disappeared from the API", model)
		}
	}
}

func TestResponseModelPriceWinsAndOriginalModelIsFallback(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "response-model.sqlite"))
	for _, price := range []string{
		`{"model":"actual-response","provider":"codex","price":{"input":2,"output":8}}`,
		`{"model":"original-alias","provider":"codex","price":{"input":1,"output":1}}`,
	} {
		if err := setCustomPrice([]byte(price)); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	handleUsage(usageEventBody("original-alias", "actual-response", now))
	handleUsage(usageEventBody("original-alias", "future-unpriced-response", now))
	handleUsage(usageEventBody("unknown-original", "unknown-response", now))
	events, _ := currentUsageAPI(t)
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	var priced, unpriced int
	var preferred *float64
	for _, e := range events {
		if e.Cost != nil {
			priced++
			if e.Model == "original-alias" && e.ResponseModel == "actual-response" {
				preferred = e.Cost
			}
		} else {
			unpriced++
		}
	}
	if preferred == nil || math.Abs(*preferred-0.0028) > 1e-12 {
		t.Fatalf("actual response model price not preferred: %v", preferred)
	}
	// Both known-price events are priced (response model first, original model
	// fallback), while the fully unknown model stays unpriced.
	if priced != 2 || unpriced != 1 {
		t.Fatalf("priced=%d unpriced=%d, events=%+v", priced, unpriced, events)
	}
}

func TestQuotaObservationsCoverEveryGPTModelWithoutWhitelist(t *testing.T) {
	openDB(filepath.Join(t.TempDir(), "quota-models.sqlite"))
	now := time.Now().Add(-time.Minute)
	models := []string{"gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-astra", "gpt-8-new"}
	for i, model := range models {
		record := usageRecord{
			Provider: "codex", Model: model, ResponseModel: model,
			AuthID: "shared-account",
			RequestedAt: now.Add(time.Duration(i) * time.Second),
			ResponseHeaders: quotaHeaders(time.Now()),
		}
		record.Detail.InputTokens = 1000
		record.Detail.OutputTokens = 100
		raw, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		handleUsage(raw)
	}
	events, quotaEvents := currentUsageAPI(t)
	if len(events) != len(models) || len(quotaEvents) != len(models) {
		t.Fatalf("want %d events and quota observations, got %d/%d", len(models), len(events), len(quotaEvents))
	}
	seen := map[string]bool{}
	for _, e := range quotaEvents {
		seen[e.ResponseModel] = true
		if e.Account != quotaEvents[0].Account {
			t.Fatalf("shared account split unexpectedly: %q vs %q", e.Account, quotaEvents[0].Account)
		}
		if e.Quota == nil || e.Quota.FiveHour == nil || e.Quota.Week == nil {
			t.Fatalf("missing quota observation for %s", e.Model)
		}
	}
	for _, model := range models {
		if !seen[model] {
			t.Fatalf("quota observation missing for %s", model)
		}
	}
}
