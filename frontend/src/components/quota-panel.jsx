import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { estimateQuotas } from "../quota";
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
        <p className="text-xs font-medium">近 30 天剩余额度</p>
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

function LazyQuotaHistory({ window: w }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-xs text-muted-foreground">配额历史</summary>
    {open && <div className="mt-3"><QuotaHistory window={w} /></div>}
  </details>;
}

export function QuotaPanel({ quotaEvents, currency, fxRate, loading }) {
  const quota = useMemo(() => estimateQuotas(quotaEvents), [quotaEvents]);
  const displayMoney = (n) => money(n, currency, fxRate);
  const quotaMoney = (n) => Number.isFinite(n) ? displayMoney(n) : "—";
  const rows = quota.accounts.flatMap((a) => ["five_hour", "week"].map((key) => ({
    account: a.account, plan: a.plan, key, window: a.windows[key],
  })));
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Codex 配额</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              {["账号 / 周期", "剩余额度", "CPA 估计消耗", `整窗估值 (${currency})`, `剩余估值 (${currency})`].map((v, i) => <TableHead key={v} className={i ? "text-right whitespace-nowrap" : "whitespace-nowrap"}>{v}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(({ account, plan, key, window: w }) => (
                <React.Fragment key={`${account}-${key}`}>
                  <TableRow>
                    <TableCell>
                      <p className="font-mono text-xs">{account}</p>
                      <p>{key === "five_hour" ? "5 小时" : "周"}{plan ? ` · ${plan}` : ""}</p>
                      {w && <p className="text-xs text-muted-foreground" title={`更新于 ${format(new Date(w.observedAt * 1000), "MM-dd HH:mm:ss")}`}>重置 {format(new Date(w.resetAt * 1000), "MM-dd HH:mm")}</p>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{!w ? "未上报" : w.active ? percent(w.remainingPercent) : "已过期"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w?.active ? percent(w.estimatedCPAPercent) : "—"}
                      {w?.active && w.unpriced > 0 && <p className="text-xs text-muted-foreground">{w.unpriced} 次未定价</p>}
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
                    <TableCell colSpan={5} className="pt-0">
                      <LazyQuotaHistory window={w} />
                    </TableCell>
                  </TableRow>}
                </React.Fragment>
              ))}
              {!rows.length && <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">{loading ? "正在加载…" : "暂无配额数据，请通过 CPA 8.x 发起 Codex 请求。"}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">配额按账户共享；金额为 API 等价估算，非实际账单，外部使用可能影响估算。</p>
      </CardContent>
    </Card>
  );
}
