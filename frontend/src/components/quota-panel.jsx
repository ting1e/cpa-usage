import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { costs, defaultPrices, estimateQuotas, formatUSD, priceSource, validatePrices } from "../quota";
import { compact } from "../analytics";

const storageKey = "cpa-usage-model-prices-v1";
export function readPrices() {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored ? validatePrices(JSON.parse(stored)) : defaultPrices;
  } catch { return defaultPrices; }
}
const percent = (n) => Number.isFinite(n) ? `${n.toFixed(2)}%` : "待学习";

export function QuotaPanel({ events, quotaEvents, prices, onPrices, loading }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(""), [error, setError] = useState("");
  const spend = useMemo(() => costs(events, prices), [events, prices]);
  const quota = useMemo(() => estimateQuotas(quotaEvents, prices), [quotaEvents, prices]);
  const rows = quota.accounts.flatMap((a) => ["five_hour", "week"].map((key) => ({
    account: a.account, plan: a.plan, key, window: a.windows[key],
  })));
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-wrap flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base">Codex 额度估算与 API 等价费用</CardTitle>
          <CardDescription className="mt-1.5">费用跟随上方日期 / 模型筛选；额度独立查看各账号当前 5h / 周周期</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={(v) => {
          setOpen(v);
          if (v) { setDraft(JSON.stringify(prices, null, 2)); setError(""); }
        }}>
          <DialogTrigger asChild><Button variant="outline" size="sm">模型单价</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>API 等价单价（USD / 百万 Token）</DialogTitle>
              <DialogDescription>input 为净输入，cache 为缓存读取，output 为输出（含推理）。默认采用官方 Standard 短上下文文本价，核对日期 2026-10-13；不自动套用 Fast、长上下文、工具、图片或缓存写入附加费用。可按你的场景修改模型 / 别名单价，仅保存到本浏览器。</DialogDescription>
            </DialogHeader>
            <a className="text-sm underline" href={priceSource} target="_blank" rel="noreferrer">查看官方价格</a>
            <textarea aria-label="模型单价 JSON" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-72 w-full rounded-md border bg-background p-3 font-mono text-xs" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(JSON.stringify(defaultPrices, null, 2))}>恢复默认</Button>
              <Button onClick={() => {
                try {
                  const next = validatePrices(JSON.parse(draft));
                  localStorage.setItem(storageKey, JSON.stringify(next));
                  onPrices(next); setOpen(false);
                } catch (e) { setError(e.message); }
              }}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Skeleton className="h-12 w-48" /> : <div>
          <p className="text-sm text-muted-foreground">所选请求的 API 等价费用{spend.unpriced ? "（已定价部分）" : ""}</p>
          <p className="text-3xl font-semibold tabular-nums">{formatUSD(spend.usd)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{spend.priced} 次已定价 / {spend.unpriced} 次未定价 · 未知模型不按零元计算 · 非订阅实际账单</p>
        </div>}
        <Alert>
          <AlertTitle>活跃期估算，不是可验证的单请求额度扣减</AlertTitle>
          <AlertDescription>仅用同账号、同模型 / 服务层、同重置周期内连续串行的 CPA 请求学习额度变化；超过 5 秒空闲、缺字段、失败、并发或重置不作为样本。外部软件在空闲期造成的变化不会累计，但外部 Codex 在 CPA 活跃期同时使用无法分离，仍可能污染估算。账号剩余额度是上次观察的全账号快照，包含外部使用，不归因给 CPA。至少 2 个有效区间且累计变化大于 0 才估算；样本代表不同请求 Token 配比时误差会增大。</AlertDescription>
        </Alert>
        <Table>
          <TableHeader><TableRow>
            {["账号 / 周期", "账号剩余快照", "活跃期变化", "本周期 CPA 估计消耗", "100% 额度等价 USD", "剩余额度等价 USD"].map((v, i) => <TableHead key={v} className={i ? "text-right" : ""}>{v}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>
            {rows.map(({ account, plan, key, window: w }) => <TableRow key={`${account}-${key}`}>
              <TableCell>
                <p className="font-mono text-xs">{account}</p>
                <p>{key === "five_hour" ? "5 小时" : "周"}{plan ? ` · ${plan}` : ""}</p>
                {w && <p className="max-w-64 truncate text-xs text-muted-foreground" title={w.model}>{w.model} · {w.tier}</p>}
                {w && <p className="text-xs text-muted-foreground">观察 {format(new Date(w.observedAt * 1000), "MM-dd HH:mm:ss")}<br />重置 {format(new Date(w.resetAt * 1000), "MM-dd HH:mm:ss")}</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{!w ? "未上报" : w.active ? percent(w.remainingPercent) : "已过期，待请求刷新"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {w ? `${w.observedPercent.toFixed(2)} 个百分点` : "—"}
                {w && <p className="text-xs text-muted-foreground">{w.samples} 个有效区间 / {w.excluded} 个排除记录</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {w?.active ? percent(w.estimatedCPAPercent) : "—"}
                {w?.active && <p className="text-xs text-muted-foreground">同模型 / 层 {w.coveredRequests} 次 · {formatUSD(w.windowUSD)}</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUSD(w?.fullUSD)}
                {w?.fullTokens != null && <p className="text-xs text-muted-foreground">≈ {compact(w.fullTokens)} Token</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUSD(w?.remainingUSD)}
                {w?.remainingTokens != null && <p className="text-xs text-muted-foreground">≈ {compact(w.remainingTokens)} Token</p>}
              </TableCell>
            </TableRow>)}
            {!rows.length && <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{loading ? "正在加载…" : "暂无可识别的 Codex 账号；升级后经 CPA 发起请求，并确认 CPA 8.x 上报 AuthID / AuthIndex 与额度响应头。"}</TableCell></TableRow>}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">读取最近 30 天本机 CPA Codex 记录；历史缺少账号或额度信息无法补算。{quota.missingAccount > 0 ? ` ${quota.missingAccount} 条缺少账号的记录未参与额度估算。` : ""} 100% / 剩余额度金额按有效活跃期样本的“百分点 / API 等价 USD”外推，只适用于该账号、模型和服务层，不是 OpenAI 公布的额度价值。</p>
      </CardContent>
    </Card>
  );
}
