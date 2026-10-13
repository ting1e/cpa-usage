import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownUp,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  KeyRound,
  Layers,
  Moon,
  RefreshCw,
  Search,
  Sun,
  WifiOff,
} from "lucide-react";
import { format, subDays } from "date-fns";
import { zhCN } from "date-fns/locale";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/segmented-control";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { compact, dateKey, fmt, formatDuration, formatTPS, groups, requestTPS, summarize, trend } from "./analytics";
import "./index.css";

const chartConfig = {
  cache: { label: "缓存输入", color: "var(--chart-1)" },
  net: { label: "净输入", color: "var(--chart-2)" },
  output: { label: "输出", color: "var(--chart-3)" },
};
const initialRange = () => {
  const today = new Date();
  return { from: today, to: today };
};
function Help({ children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground"
          aria-label="指标说明"
        >
          <CircleHelp className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}
function useCountUp(target, duration = 550) {
  const [value, setValue] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (from === target) {
      setValue(target);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(from + (target - from) * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function Metric({ label, value, raw, format, detail, help, loading }) {
  const animated = useCountUp(typeof raw === "number" ? raw : 0);
  const display =
    typeof raw === "number" && format ? format(animated) : value;
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader className="flex flex-row items-center justify-between pb-0">
        <CardDescription>{label}</CardDescription>
        <Help>{help}</Help>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-28" />
        ) : (
          <div
            className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums"
            title={String(value)}
          >
            {display}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
const API_BASE = "/v0/management/plugins/usage-report/api";
const KEY_PROMPT =
  "请返回 CPA 管理中心重新登录并勾选“记住密码”，然后刷新本页面。";

function xorBytes(bytes, keyBytes) {
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    output[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return output;
}

// Read the CPA management panel session from same-origin localStorage,
// following the secure-storage format used across the CPA plugin ecosystem.
function decodeCPAStorage(raw) {
  if (!raw) return null;
  const prefix = "enc::v1::";
  let text = raw;
  if (text.startsWith(prefix)) {
    const binary = atob(text.slice(prefix.length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const storageKey = `cli-proxy-api-webui::secure-storage|${location.host}|${navigator.userAgent}`;
    text = new TextDecoder().decode(
      xorBytes(bytes, new TextEncoder().encode(storageKey)),
    );
  }
  return JSON.parse(text);
}

function readManagementKey() {
  try {
    const parsed = decodeCPAStorage(localStorage.getItem("cli-proxy-auth"));
    const state = parsed && parsed.state ? parsed.state : parsed;
    const value = state && state.managementKey;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function App() {
  const [range, setRange] = useState(initialRange),
    [draft, setDraft] = useState(initialRange),
    [calendarOpen, setCalendarOpen] = useState(false),
    [bucket, setBucket] = useState("hour"),
    [model, setModel] = useState("all"),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState("model"),
    [page, setPage] = useState(0),
    [sort, setSort] = useState("tokens"),
    [dark, setDark] = useState(
      () => localStorage.getItem("cpa-usage-theme") === "dark",
    );
  const generation = useRef(0);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("cpa-usage-theme", dark ? "dark" : "light");
  }, [dark]);
  async function load() {
    const id = ++generation.current;
    setBusy(true);
    try {
      const key = readManagementKey();
      if (!key) throw Error(KEY_PROMPT);
      const r = await fetch(
        `${API_BASE}/usage?start=${dateKey(range.from)}&end=${dateKey(range.to)}&bucket=${bucket}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (r.status === 401 || r.status === 403) throw Error(KEY_PROMPT);
      if (!r.ok) throw Error(`服务返回 ${r.status}`);
      const d = await r.json();
      if (d.error) throw Error(d.error);
      if (id === generation.current) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (id === generation.current) setError(e.message);
    } finally {
      if (id === generation.current) {
        setBusy(false);
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [range, bucket]);
  const events = useMemo(
    () =>
      (data?.events || []).filter((e) => model === "all" || e.model === model),
    [data, model],
  );
  const stats = useMemo(() => summarize(events), [events]),
    buckets = useMemo(() => trend(events, bucket), [events, bucket]);
  const modelNames = useMemo(
    () => [...new Set((data?.events || []).map((e) => e.model))].sort(),
    [data],
  );
  useEffect(() => {
    if (model !== "all" && !modelNames.includes(model)) setModel("all");
  }, [modelNames]);
  useEffect(() => setPage(0), [tab, query, model, range, sort]);
  const rows = useMemo(() => {
    let result =
      tab === "requests"
        ? [...events].reverse()
        : groups(events, tab === "model" ? "model" : "key");
    result = result.filter((r) =>
      (r.name || r.model + " " + r.key)
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    if (tab !== "requests")
      result.sort((a, b) =>
        sort === "requests"
          ? b.n - a.n
          : sort === "tps"
            ? (b.tps ?? -1) - (a.tps ?? -1)
          : sort === "latency"
            ? (b.avgLatencyMs ?? -1) - (a.avgLatencyMs ?? -1)
          : sort === "name"
            ? a.name.localeCompare(b.name)
            : b.input + b.output - (a.input + a.output),
      );
    return result;
  }, [events, tab, query, sort]);
  const maxPage = Math.max(0, Math.ceil(rows.length / 8) - 1),
    shown = rows.slice(
      Math.min(page, maxPage) * 8,
      (Math.min(page, maxPage) + 1) * 8,
    );
  const total = stats.input + stats.output,
    rate = stats.n
      ? (((stats.n - stats.fail) / stats.n) * 100).toFixed(1)
      : null;
  const healthy =
    data?.configured && data?.collected_at && !data?.collect_err && !error;
  const quick = (days) =>
    setRange({ from: subDays(new Date(), days - 1), to: new Date() });
  const todayKey = dateKey(new Date());
  const fromKey = dateKey(range.from);
  const toKey = dateKey(range.to);
  const spansToday = toKey === todayKey;
  const activeQuick =
    spansToday && fromKey === todayKey
      ? 1
      : spansToday && fromKey === dateKey(subDays(new Date(), 6))
        ? 7
        : spansToday && fromKey === dateKey(subDays(new Date(), 29))
          ? 30
          : 0;
  return (
    <TooltipProvider>
      <div className="min-h-dvh">
        <header className="border-b bg-card">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-8">
            <a
              href="/"
              className="flex items-center gap-3 font-semibold tracking-tight"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Activity className="size-4" />
              </span>
              CPA Usage
              <Badge
                variant="outline"
                className="hidden sm:inline-flex font-normal text-muted-foreground"
              >
                LOCAL
              </Badge>
            </a>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="hidden sm:flex gap-1.5 font-normal"
              >
                {healthy ? (
                  <Check className="size-3 text-primary" />
                ) : (
                  <WifiOff className="size-3" />
                )}
                {healthy ? "采集正常" : "等待连接"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                aria-label={dark ? "切换浅色" : "切换深色"}
                onClick={() => setDark(!dark)}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                工作台 / 用量分析
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                本地优先，轻量运行。
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                数据留在本机，一个轻量服务看清请求、Token 与模型用量。
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => load()}
              disabled={busy}
            >
              <RefreshCw className={busy ? "animate-spin" : ""} />
              {busy ? "刷新中" : "刷新"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              ariaLabel="时间范围"
              value={activeQuick}
              onChange={quick}
              items={[
                { label: "今天", value: 1 },
                { label: "近 7 天", value: 7 },
                { label: "近 30 天", value: 30 },
              ]}
            />
            <Popover
              open={calendarOpen}
              onOpenChange={(o) => {
                setCalendarOpen(o);
                if (o) setDraft(range);
              }}
            >
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <CalendarDays />
                  {format(range.from, "yyyy/MM/dd")} –{" "}
                  {format(range.to, "MM/dd")}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0">
                <Calendar
                  mode="range"
                  locale={zhCN}
                  selected={draft}
                  onSelect={(v) => setDraft(v || {})}
                  defaultMonth={range.from}
                  numberOfMonths={1}
                  disabled={{ after: new Date() }}
                />
                <Separator />
                <div className="flex items-center justify-between gap-4 p-3">
                  <span className="text-xs text-muted-foreground">
                    选择开始和结束日期
                  </span>
                  <Button
                    size="sm"
                    disabled={!draft.from || !draft.to || draft.from > draft.to}
                    onClick={() => {
                      setRange(draft);
                      setCalendarOpen(false);
                    }}
                  >
                    应用
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger
                className="w-44 bg-card"
                size="sm"
                aria-label="筛选模型"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {modelNames.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-muted-foreground">
              {data?.collected_at
                ? "更新于 " + format(new Date(data.collected_at), "HH:mm:ss")
                : "每 60 秒自动刷新"}
            </span>
          </div>
          {error && (
            <Alert variant="destructive">
              <WifiOff />
              <AlertTitle>暂时无法获取用量</AlertTitle>
              <AlertDescription>
                {error}。
                {data
                  ? "下方保留上次结果，请重试。"
                  : "请确认 CLIProxyAPI 与插件运行正常。"}
              </AlertDescription>
            </Alert>
          )}
          {data?.configured && data.collect_err && (
            <Alert variant="destructive">
              <WifiOff />
              <AlertTitle>采集需要关注</AlertTitle>
              <AlertDescription>
                {data.collect_err}。历史记录仍可查看。
              </AlertDescription>
            </Alert>
          )}
          <section
            aria-label="核心指标"
            className="animate-in fade-in slide-in-from-bottom-2 duration-500 grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <Metric
              label="总 Token"
              value={compact(total)}
              raw={total}
              format={compact}
              detail={`输入 ${compact(stats.input)} / 输出 ${compact(stats.output)}`}
              help={`精确值 ${fmt(total)}。输入包含缓存，输出包含推理，不重复累加。`}
              loading={loading}
            />
            <Metric
              label="请求次数"
              value={fmt(stats.n)}
              raw={stats.n}
              format={(v) => fmt(Math.round(v))}
              detail={`${fmt(groups(events, "model").length)} 个模型参与调用`}
              help="包含成功、失败和零 Token 请求。"
              loading={loading}
            />
            <Metric
              label="请求成功率"
              value={rate === null ? "暂无" : rate + "%"}
              raw={rate ?? undefined}
              format={(v) => v.toFixed(1) + "%"}
              detail={`${fmt(stats.fail)} 次失败 / ${fmt(stats.n - stats.fail)} 次成功`}
              help="按 CPA 返回的 failed 标记统计，不推断错误原因。"
              loading={loading}
            />
            <Metric
              label="缓存命中率"
              value={
                stats.input
                  ? ((stats.cache / stats.input) * 100).toFixed(1) + "%"
                  : "暂无"
              }
              raw={stats.input ? (stats.cache / stats.input) * 100 : undefined}
              format={(v) => v.toFixed(1) + "%"}
              detail={`复用 ${compact(stats.cache)} 输入 Token`}
              help="缓存读取 Token / 输入 Token。缓存是输入的一部分。"
              loading={loading}
            />
            <Metric
              label="输出 TPS"
              value={stats.tps === null ? "暂无" : formatTPS(stats.tps)}
              raw={stats.tps ?? undefined}
              format={formatTPS}
              detail={`${fmt(stats.tpsSamples)} 次有效请求 · Token/s`}
              help="有效请求的输出 Token 总量 / 生成总耗时（秒）。生成耗时 = 总耗时 − TTFT；缺少 TTFT 时使用总耗时。排除失败、无输出和无效耗时，不重复累加推理 Token。不是并发吞吐量。"
              loading={loading}
            />
            <Metric
              label="平均总耗时"
              value={stats.avgLatencyMs === null ? "暂无" : formatDuration(stats.avgLatencyMs)}
              raw={stats.avgLatencyMs ?? undefined}
              format={formatDuration}
              detail={`${fmt(stats.latencySamples)} 次有耗时记录的请求`}
              help="请求开始到完成的总耗时的算术平均，包含成功和失败请求。零值或缺失耗时不参与平均。单位：秒。"
              loading={loading}
            />
            <Metric
              label="平均首 Token 延迟"
              value={stats.avgTTFTMs === null ? "暂无" : formatDuration(stats.avgTTFTMs)}
              raw={stats.avgTTFTMs ?? undefined}
              format={formatDuration}
              detail={`${fmt(stats.ttftSamples)} 次有效 TTFT 记录`}
              help="TTFT：请求开始到首个 Token 返回的耗时。仅对大于零且不超过总耗时的记录求算术平均，包含成功和失败请求。零值视为未上报。单位：秒。"
              loading={loading}
            />
          </section>
          <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-delay:80ms] shadow-none">
            <CardHeader className="flex flex-wrap flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Token 趋势</CardTitle>
                <CardDescription className="mt-1.5">
                  缓存输入、净输入和输出的堆叠分布
                </CardDescription>
              </div>
              <SegmentedControl
                ariaLabel="聚合粒度"
                value={bucket}
                onChange={setBucket}
                items={[
                  { label: "小时", value: "hour" },
                  { label: "天", value: "day" },
                  { label: "月", value: "month" },
                ]}
              />
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-72 w-full" />
              ) : buckets.length ? (
                <>
                  <ChartContainer
                    className="h-[280px] w-full sm:h-[330px]"
                    config={chartConfig}
                  >
                    <AreaChart
                      accessibilityLayer
                      data={buckets}
                      margin={{ top: 12, left: 0, right: 12, bottom: 0 }}
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 4" />
                      <XAxis
                        dataKey="label"
                        axisLine={false}
                        tickLine={false}
                        minTickGap={35}
                        tickMargin={12}
                        tickFormatter={(v) =>
                          bucket === "hour"
                            ? v.slice(5)
                            : bucket === "day"
                              ? v.slice(5)
                              : v
                        }
                      />
                      <YAxis
                        tickFormatter={compact}
                        axisLine={false}
                        tickLine={false}
                        width={48}
                      />
                      <ChartTooltip
                        content={<ChartTooltipContent valueFormatter={fmt} />}
                      />
                      {["cache", "net", "output"].map((k) => (
                        <Area
                          key={k}
                          dataKey={k}
                          type="linear"
                          stackId="total"
                          stroke={`var(--color-${k})`}
                          fill={`var(--color-${k})`}
                          fillOpacity={k === "output" ? 0.8 : 0.6}
                          animationDuration={450}
                          animationEasing="ease-out"
                        />
                      ))}
                    </AreaChart>
                  </ChartContainer>
                  <div className="mt-4 flex flex-wrap justify-center gap-6 text-xs text-muted-foreground">
                    {Object.entries(chartConfig).map(([k, v]) => (
                      <span key={k} className="flex items-center gap-2">
                        <span
                          className="size-2 rounded-sm"
                          style={{ background: v.color }}
                        />
                        {v.label}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex h-72 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Activity className="size-8 opacity-40" />
                  <p className="text-sm">这个时间范围内，还没有用量。</p>
                  <Button variant="outline" size="sm" onClick={() => quick(30)}>
                    查看近 30 天
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-delay:160ms] gap-0 overflow-hidden shadow-none">
            <CardHeader className="pb-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-base">用量明细</CardTitle>
                  <CardDescription className="mt-1.5">
                    从模型到每次请求，逐层查看
                  </CardDescription>
                </div>
                <div className="relative w-full sm:w-60">
                  <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="搜索模型或 Key"
                    aria-label="搜索明细"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>
            </CardHeader>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4">
                <SegmentedControl
                  ariaLabel="明细视图"
                  value={tab}
                  onChange={setTab}
                  items={[
                    {
                      label: (
                        <>
                          <Layers className="size-3.5" />
                          按模型
                        </>
                      ),
                      value: "model",
                    },
                    {
                      label: (
                        <>
                          <KeyRound className="size-3.5" />
                          按 Key
                        </>
                      ),
                      value: "key",
                    },
                    {
                      label: (
                        <>
                          <Activity className="size-3.5" />
                          请求
                        </>
                      ),
                      value: "requests",
                    },
                  ]}
                />
                {tab !== "requests" && (
                  <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger
                      className="w-36"
                      size="sm"
                      aria-label="明细排序"
                    >
                      <ArrowDownUp className="size-3" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tokens">Token 降序</SelectItem>
                      <SelectItem value="requests">请求数降序</SelectItem>
                      <SelectItem value="tps">TPS 降序</SelectItem>
                      <SelectItem value="latency">总耗时降序</SelectItem>
                      <SelectItem value="name">名称排序</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              <Separator />
              <Table>
                <TableHeader>
                  <TableRow>
                    {(tab === "requests"
                      ? ["时间 / 模型", "Key", "状态", "输入", "缓存", "输出", "总耗时", "TTFT", "TPS"]
                      : [
                          "模型 / Key",
                          "请求",
                          "成功率",
                          "输入",
                          "缓存",
                          "输出",
                          "总 Token",
                          "平均总耗时",
                          "平均 TTFT",
                          "TPS",
                        ]
                    ).map((s, i) => (
                      <TableHead key={s} className={i ? "text-right" : "pl-6"}>
                        {s}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r, i) => (
                    <TableRow
                      key={tab === "requests" ? `${r.ts}-${i}` : r.name}
                      className="animate-in fade-in duration-500"
                      style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                    >
                      {tab === "requests" ? (
                        <>
                          <TableCell className="pl-6">
                            <div className="text-xs text-muted-foreground">
                              {format(new Date(r.ts * 1000), "MM-dd HH:mm:ss")}
                            </div>
                            <div
                              className="max-w-56 truncate font-medium"
                              title={r.model}
                            >
                              {r.model}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {r.key}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge
                              variant={r.failed ? "destructive" : "secondary"}
                            >
                              {r.failed ? "失败" : "成功"}
                            </Badge>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell
                            className="max-w-64 truncate pl-6 font-medium"
                            title={r.name}
                          >
                            {r.name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmt(r.n)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(((r.n - r.fail) / r.n) * 100).toFixed(1)}%
                          </TableCell>
                        </>
                      )}
                      {["input", "cache", "output"].map((k) => (
                        <TableCell
                          key={k}
                          className="text-right tabular-nums"
                          title={fmt(r[k])}
                        >
                          {compact(r[k])}
                        </TableCell>
                      ))}
                      {tab !== "requests" && (
                        <TableCell
                          className="text-right font-medium tabular-nums"
                          title={fmt(r.input + r.output)}
                        >
                          {compact(r.input + r.output)}
                        </TableCell>
                      )}
                      <TableCell className="text-right tabular-nums">
                        {formatDuration(tab === "requests" ? r.latency_ms : r.avgLatencyMs)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDuration(tab === "requests"
                          ? (r.ttft_ms <= r.latency_ms ? r.ttft_ms : null)
                          : r.avgTTFTMs)}
                      </TableCell>
                      <TableCell className="pr-6 text-right tabular-nums">
                        {formatTPS(tab === "requests" ? requestTPS(r) : r.tps)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!shown.length && (
                    <TableRow>
                      <TableCell
                        colSpan={tab === "requests" ? 9 : 10}
                        className="h-32 text-center text-muted-foreground"
                      >
                        {loading
                          ? "正在加载明细…"
                          : query
                            ? "没有匹配结果，换个关键词试试。"
                            : "暂无明细"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <Separator />
            <div className="flex items-center justify-between px-6 py-3 text-xs text-muted-foreground">
              <span>{fmt(rows.length)} 条记录 · Key 已匿名化</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="上一页"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span>
                  {Math.min(page, maxPage) + 1} / {maxPage + 1}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="下一页"
                  disabled={page >= maxPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </Card>
          <footer className="flex flex-wrap items-center justify-between gap-2 pb-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Database className="size-3" />
              本地 SQLite · {data?.timezone || "本机时区"} · v
              {data?.version || "0.1.1"}
            </span>
            <span>
              输入包含缓存，输出包含推理
              {data?.skipped ? ` · ${data.skipped} 条无效记录未统计` : ""}
            </span>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")).render(<App />);
