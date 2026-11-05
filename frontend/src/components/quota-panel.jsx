import React, { useMemo } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { costs, estimateQuotas } from "../quota";
import { compact, money } from "../analytics";

const percent = (n) => Number.isFinite(n) ? `${n.toFixed(2)}%` : "待学习";

function Sparkline({ points }) {
  if (!points || points.length < 2) return null;
  const width = 150;
  const height = 34;
  const dots = points.map((p, i) => {
    const x = 1 + (i / (points.length - 1)) * (width - 2);
    const y = 1 + (1 - Math.max(0, Math.min(100, p.remainingPercent)) / 100) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg
      aria-label="剩余额度趋势"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      className="h-9 w-36 overflow-visible"
    >
      <polyline
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={dots}
      />
    </svg>
  );
}

function QuotaHistory({ window: w }) {
  if (!w?.history?.length) return null;
  const recent = [...w.history].reverse().slice(0, 10);
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">最近 30 天配额观察 · 剩余比例趋势</p>
        <Sparkline points={w.history} />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {["观察时间", "模型", "已用", "剩余", "重置时间"].map((label, i) => (
                <TableHead key={label} className={i ? "text-right whitespace-nowrap" : "whitespace-nowrap"}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((h, i) => (
              <TableRow key={`${h.observedAt}-${i}`}>
                <TableCell className="text-xs">{format(new Date(h.observedAt * 1000), "MM-dd HH:mm:ss")}</TableCell>
                <TableCell className="max-w-44 truncate text-right font-mono text-xs" title={h.model}>{h.model}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(h.usedPercent)}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(h.remainingPercent)}</TableCell>
                <TableCell className="text-right text-xs">{format(new Date(h.resetAt * 1000), "MM-dd HH:mm")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function QuotaPanel({ events, quotaEvents, currency, fxRate, loading }) {
  const spend = useMemo(() => costs(events), [events]);
  const quota = useMemo(() => estimateQuotas(quotaEvents), [quotaEvents]);
  const displayMoney = (n) => money(n, currency, fxRate);
  const quotaMoney = (n) => Number.isFinite(n) ? displayMoney(n) : "—";
  const rows = quota.accounts.flatMap((a) => ["five_hour", "week"].map((key) => ({
    account: a.account, plan: a.plan, key, window: a.windows[key],
  })));
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Codex 多账户配额与 API 等价费用</CardTitle>
        <CardDescription className="mt-1.5">
          费用跟随上方日期 / 模型筛选；Codex 配额按账户独立查看当前 5h / 周周期，不同 GPT 模型共享同一账户配额时只计一次。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Skeleton className="h-12 w-48" /> : <div>
          <p className="text-sm text-muted-foreground">所选请求的 API 等价费用{spend.unpriced ? "（已定价部分）" : ""}</p>
          <p className="text-3xl font-semibold tabular-nums">{displayMoney(spend.usd)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{spend.priced} 次已定价 / {spend.unpriced} 次未定价 · 后端统一价格引擎 · 非订阅实际账单</p>
        </div>}
        <Alert>
          <AlertTitle>按账户估算，不把共享配额重复分给每个模型</AlertTitle>
          <AlertDescription>
            仅用同账号、同重置周期内连续串行的 CPA 请求学习额度变化；超过 5 秒空闲、缺字段、失败、并发、缺价或重置不作为样本。Sol、Terra、Luna、Astra 及其他 GPT 模型共用账户配额时合并校准，并按模型展示 Token / 费用明细；如果服务端将来提供独立模型配额，再拆分统计。外部软件在空闲期造成的变化不会累计，但外部 Codex 在 CPA 活跃期同时使用无法分离，仍可能污染估算。账号剩余额度是上次观察的全账号快照，包含外部使用，不归因给 CPA。至少 2 个有效区间且累计变化大于 0 才估算。
          </AlertDescription>
        </Alert>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              {["账号 / 周期", "账号剩余快照", "活跃期变化", "本周期 CPA 估计消耗", "100% 额度等价金额", "剩余额度等价金额"].map((v, i) => <TableHead key={v} className={i ? "text-right whitespace-nowrap" : "whitespace-nowrap"}>{v}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(({ account, plan, key, window: w }) => (
                <React.Fragment key={`${account}-${key}`}>
                  <TableRow>
                    <TableCell>
                      <p className="font-mono text-xs">{account}</p>
                      <p>{key === "five_hour" ? "5 小时" : "周"}{plan ? ` · ${plan}` : ""}</p>
                      {w && <p className="max-w-64 truncate text-xs text-muted-foreground" title={w.sampleModels?.join(", ")}>{w.sampleModels?.length ? `${w.sampleModels.length} 个样本模型` : "等待样本"}{w.tiers?.length ? ` · ${w.tiers.join(" / ")}` : ""}</p>}
                      {w && <p className="text-xs text-muted-foreground">观察 {format(new Date(w.observedAt * 1000), "MM-dd HH:mm:ss")}<br />重置 {format(new Date(w.resetAt * 1000), "MM-dd HH:mm:ss")}</p>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{!w ? "未上报" : w.active ? percent(w.remainingPercent) : "已过期，待请求刷新"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w ? `${w.observedPercent.toFixed(2)} 个百分点` : "—"}
                      {w && <p className="text-xs text-muted-foreground">{w.samples} 个有效区间 / {w.excluded} 个排除记录</p>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w?.active ? percent(w.estimatedCPAPercent) : "—"}
                      {w?.active && <p className="text-xs text-muted-foreground">账户内 {w.coveredRequests} 次 · {quotaMoney(w.windowUSD)}{w.unpriced ? ` · ${w.unpriced} 未定价` : ""}</p>}
                      {w?.active && !!w.models?.length && <div className="mt-1 space-y-0.5 text-left text-[10px] text-muted-foreground">
                        {w.models.slice(0, 4).map((m) => <p key={m.model} className="max-w-64 truncate" title={`${m.model} · ${m.requests} 次`}>{m.model} · {compact(m.input + m.output)} Token · {quotaMoney(m.cost)}</p>)}
                        {w.models.length > 4 && <p>另有 {w.models.length - 4} 个模型</p>}
                      </div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {quotaMoney(w?.fullUSD)}
                      {w?.fullTokens != null && <p className="text-xs text-muted-foreground">≈ {compact(w.fullTokens)} Token</p>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {quotaMoney(w?.remainingUSD)}
                      {w?.remainingTokens != null && <p className="text-xs text-muted-foreground">≈ {compact(w.remainingTokens)} Token</p>}
                    </TableCell>
                  </TableRow>
                  {w?.history?.length > 0 && <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="pt-0">
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">查看配额历史（{w.history.length} 次观察）</summary>
                        <div className="mt-3"><QuotaHistory window={w} /></div>
                      </details>
                    </TableCell>
                  </TableRow>}
                </React.Fragment>
              ))}
              {!rows.length && <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{loading ? "正在加载…" : "暂无可识别的 Codex 账号；升级后经 CPA 发起请求，并确认 CPA 8.x 上报 AuthID / AuthIndex 与额度响应头。"}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">读取最近 30 天本机 CPA Codex 记录；历史缺少账号或额度信息无法补算。{quota.missingAccount > 0 ? ` ${quota.missingAccount} 条缺少账号的记录未参与额度估算。` : ""} 100% / 剩余额度金额按有效活跃期样本的“百分点 / API 等价 USD”外推，只适用于该账号的共享配额，不是 OpenAI 公布的额度价值。显示币种 {currency}{currency === "CNY" ? `，按 1 USD = ${fxRate} CNY 换算` : ""}。</p>
      </CardContent>
    </Card>
  );
}
