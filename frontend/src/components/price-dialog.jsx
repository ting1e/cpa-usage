import { useState } from "react";
import { DollarSign, Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { convertUSD } from "../analytics";
import { priceInUSD } from "../currency";

const fields = [["input", "普通输入"], ["cache_read", "缓存读取"], ["cache_write", "缓存写入"], ["output", "输出"]];
const rowKey = (row) => JSON.stringify([row.provider, row.model]);
const rate = (n, currency) => n == null ? "—" : `${currency === "CNY" ? "¥" : "$"}${n.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
const priceUnit = (currency) => `${currency === "CNY" ? "人民币" : "美元"} / 百万 Token`;

export function PriceDialog({ request, onSaved, currency, fxRate }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null),
    [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [query, setQuery] = useState(""), [editing, setEditing] = useState(null),
    [draft, setDraft] = useState({});
  async function run(action) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const load = async () => setData(await request("/pricing"));
  async function save(row, price) {
    await run(async () => {
      setData(await request("/pricing", { method: "POST", body: JSON.stringify({ model: row.model, provider: row.provider, price }) }));
      setEditing(null);
      await onSaved();
    });
  }
  const rows = (data?.models || []).filter((row) => `${row.model} ${row.provider}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={(value) => {
      setOpen(value);
      if (value) { setEditing(null); run(load); }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><DollarSign className="size-4" /><span className="hidden sm:inline">价格表</span><span className="sr-only sm:hidden">价格表</span></Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>模型价格表</DialogTitle>
          <DialogDescription>{priceUnit(currency)}{currency === "CNY" ? ` · 1 USD = ${fxRate} CNY` : ""} · 标准文本用量估算，含默认缓存写入价格；不含订阅费、工具费及特殊服务档位。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            来源 <a className="underline underline-offset-4" href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json" target="_blank" rel="noreferrer">LiteLLM</a>
            {data && ` · 版本 ${data.version} · 最近检查 ${new Date(data.checked_at * 1000).toLocaleString("zh-CN")}`}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { setData(await request("/pricing/refresh", { method: "POST" })); await onSaved(); })}>
            <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />{busy ? "处理中" : "更新价格"}
          </Button>
        </div>
        {(error || data?.update_error) && <p role="alert" className="text-sm text-destructive">{error || data.update_error}</p>}
        <Input aria-label="搜索价格表" placeholder="搜索已调用的模型或提供方…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-[42dvh] overflow-auto rounded-md border">
          <Table>
            <TableHeader><TableRow>
              <TableHead>模型 / 提供方</TableHead>
              {fields.map(([key, label]) => <TableHead key={key} className="py-2 text-right whitespace-nowrap">{label}<span className="mt-1 block text-[10px] font-normal text-muted-foreground">{priceUnit(currency)}</span></TableHead>)}
              <TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => <TableRow key={rowKey(row)}>
                <TableCell className="max-w-56">
                  <div className="truncate font-medium" title={row.model}>{row.model}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {row.provider || "未知提供方"}
                    <Badge variant="outline" className="text-[10px]">{row.custom ? "自定义" : row.price ? "公开价格" : "未定价"}</Badge>
                    {!!row.price?.tiers?.length && <span>含长上下文阶梯</span>}
                  </div>
                </TableCell>
                {fields.map(([key]) => <TableCell className="text-right tabular-nums whitespace-nowrap" key={key}>{rate(convertUSD(row.price?.[key], currency, fxRate), currency)}</TableCell>)}
                <TableCell><div className="flex justify-end">
                  <Button size="icon" variant="ghost" aria-label={`编辑 ${row.model} ${row.provider} 价格`} disabled={busy} onClick={() => { setEditing({ ...row, currency, fxRate }); setDraft(Object.fromEntries(fields.map(([key]) => [key, convertUSD(row.price?.[key], currency, fxRate) ?? ""]))); setError(""); }}><Pencil className="size-3.5" /></Button>
                  {row.custom && <Button size="icon" variant="ghost" aria-label={`恢复 ${row.model} ${row.provider} 公开价格`} disabled={busy} onClick={() => save(row, null)}><RotateCcw className="size-3.5" /></Button>}
                </div></TableCell>
              </TableRow>)}
              {!rows.length && <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{busy ? "正在加载价格…" : data ? "没有匹配的已调用模型" : "价格表尚未加载"}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        {editing && <form className="space-y-3 rounded-md border bg-muted/30 p-4" onSubmit={(e) => {
          e.preventDefault();
          save(editing, Object.fromEntries(fields.map(([key]) => [key, priceInUSD(draft[key], editing.price?.[key], editing.currency, editing.fxRate)])));
        }}>
          <p className="break-all text-sm font-medium">自定义价格 · {editing.model} / {editing.provider || "未知提供方"}</p>
          <p className="text-xs text-muted-foreground">{priceUnit(editing.currency)}{editing.currency === "CNY" ? ` · 按 1 USD = ${editing.fxRate} CNY 换算后保存` : ""}</p>
          {!!editing.price?.tiers?.length && <p className="text-xs text-muted-foreground">保存为固定单价，将覆盖这个提供方的公开阶梯价格。</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {fields.map(([key, label]) => <label key={key} className="space-y-1.5 text-xs text-muted-foreground">
              <span className="block">{label}<span className="mt-1 block text-[10px]">{priceUnit(editing.currency)}</span></span>
              <Input aria-label={`${label}单价（${priceUnit(editing.currency)}）`} type="number" min="0" step="any" required={key === "input" || key === "output"} placeholder="未定价" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
            </label>)}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>取消</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "保存中" : "保存价格"}</Button>
          </div>
        </form>}
        <p className="text-xs leading-relaxed text-muted-foreground">每 24 小时检查更新，离线继续使用本地价格。自定义单价按模型和提供方保存，优先于公开价格；空白缓存单价表示未定价，0 表示免费。变更保留历史版本，过去缺价的请求按首个可用价格估算。阶梯模型显示基础单价，计算时自动选用对应输入长度的档位。</p>
      </DialogContent>
    </Dialog>
  );
}
