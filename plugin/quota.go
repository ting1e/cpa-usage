package main

import (
	"math"
	"strconv"
	"strings"
	"time"
)

type quotaWindow struct {
	UsedPercent float64 `json:"used_percent"`
	ResetAt     int64   `json:"reset_at"`
}

type codexQuota struct {
	Plan     string       `json:"plan"`
	FiveHour *quotaWindow `json:"five_hour"`
	Week     *quotaWindow `json:"week"`
}

// Retain only bounded quota scalars, never arbitrary upstream headers/secrets.
func parseCodexQuota(headers map[string][]string, observed time.Time) *codexQuota {
	values := map[string]string{}
	for key, items := range headers {
		if len(items) > 0 {
			values[strings.ToLower(key)] = items[0]
		}
	}
	q := &codexQuota{}
	plan := strings.ToLower(strings.TrimSpace(values["x-codex-plan-type"]))
	switch plan {
	case "free", "go", "plus", "pro", "team", "business", "enterprise", "edu":
		q.Plan = plan
	}
	for _, name := range []string{"primary", "secondary"} {
		prefix := "x-codex-" + name + "-"
		used, err := strconv.ParseFloat(values[prefix+"used-percent"], 64)
		if err != nil || math.IsNaN(used) || math.IsInf(used, 0) || used < 0 || used > 100 {
			continue
		}
		minutes, err := strconv.Atoi(values[prefix+"window-minutes"])
		if err != nil || (minutes != 300 && minutes != 10080) {
			continue
		}
		reset, err := strconv.ParseInt(values[prefix+"reset-at"], 10, 64)
		if err != nil || reset <= 0 {
			after, err := strconv.ParseInt(values[prefix+"reset-after-seconds"], 10, 64)
			if err != nil || after <= 0 || after > int64(minutes)*60+300 {
				continue
			}
			reset = observed.Unix() + after
		}
		if reset <= observed.Unix() || reset > observed.Unix()+int64(minutes)*60+300 {
			continue
		}
		window := &quotaWindow{UsedPercent: used, ResetAt: reset}
		if minutes == 300 {
			q.FiveHour = window
		} else {
			q.Week = window
		}
	}
	if q.FiveHour == nil && q.Week == nil {
		return nil
	}
	return q
}
