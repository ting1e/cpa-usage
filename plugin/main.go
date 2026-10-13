package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

static const cliproxy_host_api* stored_host;

static void store_host_api(const cliproxy_host_api* host) {
	stored_host = host;
}

static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	if (stored_host == NULL || stored_host->call == NULL) {
		return 1;
	}
	return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}

static void free_host_buffer(void* ptr, size_t len) {
	if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) {
		stored_host->free_buffer(ptr, len);
	}
}
*/
import "C"

import (
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	_ "modernc.org/sqlite"
)

//go:embed web/index.html web/assets/*
var webFS embed.FS

const abiVersion uint32 = 1

// version is injected at release time via -ldflags "-X main.version=..."
var version = "0.3.6"

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

var (
	mu       sync.Mutex
	db       *sql.DB
	lastRecv time.Time
	lastErr  string
)

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	C.store_host_api(host)
	plugin.abi_version = C.uint32_t(abiVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	var req []byte
	if request != nil && requestLen > 0 {
		req = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, err := handleMethod(C.GoString(method), req)
	if err != nil {
		writeResponse(response, errorEnvelope("plugin_error", err.Error()))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, len C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
	_ = len
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	mu.Lock()
	defer mu.Unlock()
	if db != nil {
		_ = db.Close()
		db = nil
	}
}

func handleMethod(method string, req []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		applyConfig(req)
		return okEnvelopeJSON(`{"schema_version":1,"metadata":{"Name":"usage-report","Version":"` + version + `","Author":"ting1e","GitHubRepository":"https://github.com/ting1e/cpa-usage","Logo":"","ConfigFields":[]},"capabilities":{"usage_plugin":true,"management_api":true}}`)
	case "management.register":
		return okEnvelopeJSON(`{"routes":[
			{"Method":"GET","Path":"/plugins/usage-report/api/usage","Menu":"","Description":"usage data api"},
			{"Method":"GET","Path":"/plugins/usage-report/api/health","Menu":"","Description":"health"},
			{"Method":"POST","Path":"/plugins/usage-report/api/collect","Menu":"","Description":"collect trigger"}
		],"resources":[
			{"Path":"/report","Menu":"Usage Report","Description":"CPA usage dashboard"},
			{"Path":"/assets/index-BbaLNx4Z.js","Menu":"","Description":"dashboard js"},
			{"Path":"/assets/index-B1mpJtDC.css","Menu":"","Description":"dashboard css"}
		]}`)
	case "usage.handle":
		handleUsage(req)
		return okEnvelopeJSON(`{}`)
	case "management.handle":
		return handleManagement(req)
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

// ---- config ----

func applyConfig(req []byte) {
	var parsed struct {
		ConfigYaml string `json:"config_yaml"`
	}
	_ = json.Unmarshal(req, &parsed)
	if parsed.ConfigYaml == "" {
		// Some host versions wrap the payload in a {"result": {...}} envelope.
		var wrapped struct {
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(req, &wrapped); err == nil && wrapped.Result != nil {
			_ = json.Unmarshal(wrapped.Result, &parsed)
		}
	}
	if parsed.ConfigYaml == "" {
		return
	}
	path := ""
	for _, line := range strings.Split(parsed.ConfigYaml, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "db_path:") {
			path = strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "db_path:")), `"'`)
			break
		}
	}
	if path == "" {
		return
	}
	if strings.HasPrefix(path, "~") {
		if u, err := user.Current(); err == nil {
			path = filepath.Join(u.HomeDir, path[2:])
		}
	}
	openDB(path)
}

func defaultDBPath() string {
	u, err := user.Current()
	if err != nil {
		return "usage.sqlite"
	}
	return filepath.Join(u.HomeDir, ".cli-proxy-api", "usage-report.sqlite")
}

func openDB(path string) {
	mu.Lock()
	defer mu.Unlock()
	if db != nil && path != "" && lastOpened == path {
		return
	}
	if db != nil {
		_ = db.Close()
	}
	conn, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		lastErr = "sqlite open: " + err.Error()
		return
	}
	_, err = conn.Exec("CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, dedup TEXT UNIQUE, payload TEXT)")
	if err != nil {
		lastErr = "sqlite migrate: " + err.Error()
		_ = conn.Close()
		return
	}
	db = conn
	lastOpened = path
	lastErr = ""
}

var lastOpened string

func ensureDB() {
	if db == nil {
		openDB(defaultDBPath())
	}
}

// ---- usage ----

func handleUsage(req []byte) {
	var parsed struct {
		Result json.RawMessage `json:"result"`
	}
	if len(req) > 0 {
		_ = json.Unmarshal(req, &parsed)
	}
	rec := parsed.Result
	if rec == nil {
		rec = req
	}
	var u usageRecord
	if err := json.Unmarshal(rec, &u); err != nil {
		return
	}
	lastRecv = time.Now()

	model := u.Model
	if model == "" {
		model = u.Alias
	}
	if model == "" {
		model = "unknown"
	}
	ts := u.RequestedAt
	if ts.IsZero() {
		ts = time.Now()
	}
	tokens := map[string]int64{
		"input_tokens":          u.Detail.InputTokens,
		"output_tokens":         u.Detail.OutputTokens,
		"reasoning_tokens":      u.Detail.ReasoningTokens,
		"cached_tokens":         u.Detail.CachedTokens,
		"cache_read_tokens":     u.Detail.CacheReadTokens,
		"cache_creation_tokens": u.Detail.CacheCreationTokens,
		"total_tokens":          u.Detail.TotalTokens,
	}
	source := u.Source
	if source == "" {
		source = u.APIKey
	}
	event := map[string]interface{}{
		"timestamp":  ts.Format(time.RFC3339Nano),
		"model":      model,
		"source":     source,
		"failed":     u.Failed,
		"latency_ms": float64(u.Latency) / float64(time.Millisecond),
		"ttft_ms":    float64(u.TTFT) / float64(time.Millisecond),
		"tokens":     tokens,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	digest := sha1.Sum(payload)
	// Keep the existing dedup identity when adding optional protocol metadata.
	if u.Provider != "" || u.ExecutorType != "" || u.AuthID != "" || u.AuthIndex != "" || u.RequestID != "" || len(u.ResponseHeaders) > 0 {
		event["provider"] = u.Provider
		event["executor_type"] = u.ExecutorType
		if u.AuthID != "" || u.AuthIndex != "" || u.RequestID != "" || len(u.ResponseHeaders) > 0 {
			event["auth_id"] = u.AuthID
			event["auth_index"] = u.AuthIndex
			event["auth_type"] = u.AuthType
			event["request_id"] = u.RequestID
			event["response_model"] = u.ResponseModel
			event["service_tier"] = u.ResponseServiceTier
			if u.ResponseServiceTier == "" {
				event["service_tier"] = u.ServiceTier
			}
			event["observed_at"] = time.Now().Format(time.RFC3339Nano)
			event["quota"] = parseCodexQuota(u.ResponseHeaders, time.Now())
		}
		payload, err = json.Marshal(event)
		if err != nil {
			return
		}
	}

	ensureDB()
	mu.Lock()
	defer mu.Unlock()
	if db == nil {
		return
	}
	_, _ = db.Exec("INSERT OR IGNORE INTO usage_events (ts, dedup, payload) VALUES (?,?,?)",
		ts.Format("2006-01-02 15:04:05"), hex.EncodeToString(digest[:]), string(payload))
}

type usageRecord struct {
	AuthID              string
	AuthIndex           string
	AuthType            string
	RequestID           string
	ResponseModel       string
	ServiceTier         string
	ResponseServiceTier string
	ResponseHeaders     map[string][]string
	Provider            string
	ExecutorType        string
	Model               string
	Alias               string
	APIKey              string
	Source              string
	ReasoningEffort     string
	RequestedAt         time.Time
	Latency             time.Duration
	TTFT                time.Duration
	Failed              bool
	Detail              struct {
		InputTokens         int64
		OutputTokens        int64
		ReasoningTokens     int64
		CachedTokens        int64
		CacheReadTokens     int64
		CacheCreationTokens int64
		TotalTokens         int64
	}
}

// ---- management ----

func handleManagement(req []byte) ([]byte, error) {
	var parsed struct {
		Result json.RawMessage `json:"result"`
	}
	if len(req) > 0 {
		_ = json.Unmarshal(req, &parsed)
	}
	rec := parsed.Result
	if rec == nil {
		rec = req
	}
	var m struct {
		Method string
		Path   string
		Query  map[string][]string
	}
	if err := json.Unmarshal(rec, &m); err != nil {
		return errorEnvelope("bad_request", err.Error()), nil
	}

	if strings.HasSuffix(m.Path, "/report") || m.Path == "" {
		html, err := webFS.ReadFile("web/index.html")
		if err != nil {
			return errorEnvelope("asset_missing", err.Error()), nil
		}
		return managementResponse(200, "text/html; charset=utf-8", html)
	}
	if strings.HasSuffix(m.Path, "/assets/index-BbaLNx4Z.js") {
		js, err := webFS.ReadFile("web/assets/index-BbaLNx4Z.js")
		if err != nil {
			return errorEnvelope("asset_missing", err.Error()), nil
		}
		return managementResponse(200, "application/javascript; charset=utf-8", js)
	}
	if strings.HasSuffix(m.Path, "/assets/index-B1mpJtDC.css") {
		css, err := webFS.ReadFile("web/assets/index-B1mpJtDC.css")
		if err != nil {
			return errorEnvelope("asset_missing", err.Error()), nil
		}
		return managementResponse(200, "text/css; charset=utf-8", css)
	}
	if strings.HasSuffix(m.Path, "/api/health") {
		body, _ := json.Marshal(map[string]interface{}{"service": "cpa-usage", "version": version, "pid": 0})
		return managementResponse(200, "application/json; charset=utf-8", body)
	}
	if strings.HasSuffix(m.Path, "/api/collect") {
		collectOnce()
		body, _ := json.Marshal(map[string]interface{}{"collected_at": collectedAt(), "collect_err": collectErr()})
		return managementResponse(200, "application/json; charset=utf-8", body)
	}
	if strings.HasSuffix(m.Path, "/api/usage") {
		body, err := usageResponse(m.Query)
		if err != nil {
			b, _ := json.Marshal(map[string]interface{}{"error": err.Error()})
			return managementResponse(400, "application/json; charset=utf-8", b)
		}
		return managementResponse(200, "application/json; charset=utf-8", body)
	}
	return managementResponse(404, "text/plain; charset=utf-8", []byte("not found"))
}

func managementResponse(status int, contentType string, body []byte) ([]byte, error) {
	obj, err := json.Marshal(map[string]interface{}{
		"StatusCode": status,
		"Headers":    map[string][]string{"content-type": {contentType}},
		"Body":       body,
	})
	if err != nil {
		return errorEnvelope("encode_error", err.Error()), nil
	}
	return json.Marshal(envelope{OK: true, Result: obj})
}

// ---- usage api (compatible with cpa-usage frontend contract) ----

type dbEvent struct {
	AuthID        string         `json:"auth_id"`
	AuthIndex     string         `json:"auth_index"`
	AuthType      string         `json:"auth_type"`
	RequestID     string         `json:"request_id"`
	ResponseModel string         `json:"response_model"`
	ServiceTier   string         `json:"service_tier"`
	ObservedAt    string         `json:"observed_at"`
	Quota         *codexQuota    `json:"quota"`
	Timestamp     string         `json:"timestamp"`
	Model         string         `json:"model"`
	Provider      string         `json:"provider"`
	ExecutorType  string         `json:"executor_type"`
	Alias         string         `json:"alias"`
	Source        string         `json:"source"`
	APIKey        string         `json:"api_key"`
	Failed        bool           `json:"failed"`
	LatencyMs     float64        `json:"latency_ms"`
	TTFTMs        float64        `json:"ttft_ms"`
	Tokens        map[string]any `json:"tokens"`
}

type outEvent struct {
	Provider      string      `json:"provider"`
	Account       string      `json:"account"`
	AuthType      string      `json:"auth_type"`
	ResponseModel string      `json:"response_model"`
	ServiceTier   string      `json:"service_tier"`
	ObservedTs    float64     `json:"observed_ts"`
	Quota         *codexQuota `json:"quota"`
	Ts            float64     `json:"ts"`
	Model         string      `json:"model"`
	Key           string      `json:"key"`
	Input         int64       `json:"input"`
	Output        int64       `json:"output"`
	Cache         int64       `json:"cache"`
	Reasoning     int64       `json:"reasoning"`
	Failed        bool        `json:"failed"`
	LatencyMs     float64     `json:"latency_ms"`
	TTFTMs        float64     `json:"ttft_ms"`
	TPS           *float64    `json:"tps"`
}

// requestTPS measures output generation speed, not concurrent throughput.
// A zero TTFT means the host did not report it, so use the full latency.
func requestTPS(output int64, latencyMs, ttftMs float64, failed bool) *float64 {
	if failed || output <= 0 || latencyMs <= 0 || ttftMs < 0 || ttftMs >= latencyMs ||
		math.IsNaN(latencyMs) || math.IsInf(latencyMs, 0) || math.IsNaN(ttftMs) || math.IsInf(ttftMs, 0) {
		return nil
	}
	tps := float64(output) * 1000 / (latencyMs - ttftMs)
	if math.IsNaN(tps) || math.IsInf(tps, 0) {
		return nil
	}
	return &tps
}

type outBucket struct {
	Label    string `json:"label"`
	Input    int64  `json:"input"`
	Output   int64  `json:"output"`
	Cache    int64  `json:"cache"`
	Requests int64  `json:"requests"`
}

func anonKey(source string) string {
	if source == "" {
		return "未知 Key"
	}
	sum := sha256.Sum256([]byte(source))
	return "key-" + hex.EncodeToString(sum[:])[:10]
}

func usageResponse(q map[string][]string) ([]byte, error) {
	get := func(k string) string {
		if v, ok := q[k]; ok && len(v) > 0 {
			return v[0]
		}
		return ""
	}
	startStr := get("start")
	endStr := get("end")
	bucket := get("bucket")
	if bucket == "" {
		bucket = "day"
	}
	if bucket != "hour" && bucket != "day" && bucket != "month" {
		return nil, fmt.Errorf("无效时间粒度")
	}
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	var a, b time.Time
	if startStr != "" {
		var err error
		a, err = time.ParseInLocation("2006-01-02", startStr, time.Local)
		if err != nil {
			return nil, fmt.Errorf("无效开始日期")
		}
	} else {
		a = today.AddDate(0, 0, -6)
	}
	if endStr != "" {
		var err error
		b, err = time.ParseInLocation("2006-01-02", endStr, time.Local)
		if err != nil {
			return nil, fmt.Errorf("无效结束日期")
		}
	} else {
		b = today
	}
	if a.After(b) {
		return nil, fmt.Errorf("开始日期不能晚于结束日期")
	}
	lo := float64(a.Unix())
	hi := float64(b.AddDate(0, 0, 1).Unix())

	events := []outEvent{}
	quotaEvents := []outEvent{}
	bins := map[string]*outBucket{}
	order := []string{}
	skipped := 0

	ensureDB()
	mu.Lock()
	var rows *sql.Rows
	var err error
	if db != nil {
		rows, err = db.Query("SELECT ts, payload FROM usage_events ORDER BY id")
	}
	mu.Unlock()
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var storedTs, payload string
			if err := rows.Scan(&storedTs, &payload); err != nil {
				continue
			}
			var e dbEvent
			if err := json.Unmarshal([]byte(payload), &e); err != nil {
				skipped++
				continue
			}
			tsStr := e.Timestamp
			if tsStr == "" {
				tsStr = storedTs
			}
			ts, err := parseAnyTime(tsStr)
			if err != nil {
				skipped++
				continue
			}
			model := e.Model
			if model == "" {
				model = e.Alias
			}
			if model == "" {
				model = "unknown"
			}
			source := e.Source
			if source == "" {
				source = e.APIKey
			}
			var input, output, cache, reasoning int64
			if t := e.Tokens; t != nil {
				input = toI64(t["input_tokens"])
				output = toI64(t["output_tokens"])
				read := toI64(t["cache_read_tokens"])
				cached := toI64(t["cached_tokens"])
				creation := toI64(t["cache_creation_tokens"])
				cache = read
				if cache == 0 && cached > 0 && creation == 0 {
					cache = cached
				}
				reasoning = toI64(t["reasoning_tokens"])
				if addInputCache(e, input, output, cache, creation, reasoning) {
					input += cache + creation
				}
			}
			account := e.AuthID
			if account == "" {
				account = e.AuthIndex
			}
			if account != "" {
				account = "account-" + strings.TrimPrefix(anonKey(account), "key-")
			}
			observedTs, _ := parseAnyTime(e.ObservedAt)
			out := outEvent{
				Provider: e.Provider, Account: account, AuthType: e.AuthType,
				ResponseModel: e.ResponseModel, ServiceTier: e.ServiceTier,
				ObservedTs: observedTs, Quota: e.Quota,
				Ts: ts, Model: model, Key: anonKey(source),
				Input: input, Output: output, Cache: cache, Reasoning: reasoning,
				Failed: e.Failed, LatencyMs: e.LatencyMs, TTFTMs: e.TTFTMs,
				TPS: requestTPS(output, e.LatencyMs, e.TTFTMs, e.Failed),
			}
			// Quota estimation is independent of the dashboard date/model filters.
			if strings.EqualFold(e.Provider, "codex") && ts >= float64(now.AddDate(0, 0, -30).UnixNano())/1e9 && ts <= float64(now.UnixNano())/1e9 {
				quotaEvents = append(quotaEvents, out)
			}
			if ts < lo || ts >= hi {
				continue
			}
			events = append(events, out)
			t := time.Unix(int64(ts), 0)
			var label string
			switch bucket {
			case "hour":
				label = t.Format("2006-01-02 15") + ":00"
			case "month":
				label = t.Format("2006-01")
			default:
				label = t.Format("2006-01-02")
			}
			bk := bins[label]
			if bk == nil {
				bk = &outBucket{Label: label}
				bins[label] = bk
				order = append(order, label)
			}
			bk.Input += input
			bk.Output += output
			bk.Cache += cache
			bk.Requests++
		}
	}
	sort.Strings(order)
	buckets := make([]*outBucket, 0, len(order))
	for _, l := range order {
		buckets = append(buckets, bins[l])
	}

	resp := map[string]interface{}{
		"events":       events,
		"quota_events": quotaEvents,
		"buckets":      buckets,
		"collected_at": collectedAt(),
		"collect_err":  collectErr(),
		"skipped":      skipped,
		"version":      version,
		"configured":   true,
		"timezone":     time.Now().Format("MST"),
	}
	return json.Marshal(resp)
}

func addInputCache(e dbEvent, input, output, cache, creation, reasoning int64) bool {
	cachedInput := cache + creation
	if cachedInput <= 0 {
		return false
	}
	total := toI64(e.Tokens["total_tokens"])
	// An inclusive total must never receive cache a second time.
	if total > 0 && total == input+output {
		return false
	}
	provider := strings.ToLower(strings.TrimSpace(e.Provider))
	executor := strings.ToLower(strings.TrimSpace(e.ExecutorType))
	if executor == "openaicompatexecutor" || provider == "openai-compatibility" || strings.HasPrefix(provider, "openai-compatible-") {
		return false
	}
	protocol := provider + " " + executor
	if strings.Contains(protocol, "claude") || strings.Contains(protocol, "anthropic") {
		return total == 0 || total == input+output+cachedInput
	}
	if provider != "" || executor != "" {
		return false
	}
	// Old rows have no protocol identity. Only repair counts that cannot be
	// an input subset; total equality alone also matches Gemini reasoning.
	if cachedInput <= input {
		return false
	}
	return (total == 0 && input == 0) ||
		(total == input+output+cachedInput && total != input+output+reasoning)
}

func parseAnyTime(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty time")
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return float64(t.UnixNano()) / 1e9, nil
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", s, time.Local); err == nil {
		return float64(t.UnixNano()) / 1e9, nil
	}
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return float64(t.UnixNano()) / 1e9, nil
	}
	return 0, fmt.Errorf("unsupported time %q", s)
}

func collectedAt() interface{} {
	// Report the data freshness timestamp as of this response: with real-time
	// collection this means "the dashboard data is current as of now".
	return time.Now().Format(time.RFC3339Nano)
}

func collectErr() interface{} {
	mu.Lock()
	defer mu.Unlock()
	if lastErr == "" {
		return nil
	}
	return lastErr
}

func collectOnce() {
	ensureDB()
	mu.Lock()
	lastRecv = time.Now()
	mu.Unlock()
}

func toI64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}

// ---- envelope helpers ----

func okEnvelopeJSON(result string) ([]byte, error) {
	return json.Marshal(envelope{OK: true, Result: json.RawMessage(result)})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}

func callHost(method string, payload []byte) {
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var response C.cliproxy_buffer
	var req *C.uint8_t
	if len(payload) > 0 {
		req = (*C.uint8_t)(C.CBytes(payload))
		defer C.free(unsafe.Pointer(req))
	}
	if C.call_host_api(cMethod, req, C.size_t(len(payload)), &response) == 0 && response.ptr != nil {
		C.free_host_buffer(response.ptr, response.len)
	}
}

var _ = os.Getenv
