import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/segmented-control";
import { validFxRate } from "../currency";

export function CurrencyControl({ value, onChange }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(""), [error, setError] = useState("");
  return <div className="flex flex-wrap items-center gap-2">
    <SegmentedControl ariaLabel="显示币种" value={value.currency}
      onChange={(currency) => onChange({ ...value, currency })}
      items={[{ label: "USD 美元", value: "USD" }, { label: "CNY 人民币", value: "CNY" }]} />
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) { setDraft(String(value.fxRate)); setError(""); }
    }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="修改美元兑人民币汇率">
          1 USD = {value.fxRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} CNY
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <form className="space-y-3" noValidate onSubmit={(e) => {
          e.preventDefault();
          const fxRate = Number(draft);
          if (!validFxRate(fxRate)) { setError("请输入大于 0 的有效汇率"); return; }
          onChange({ ...value, fxRate }); setOpen(false);
        }}>
          <label className="space-y-2 text-sm font-medium">
            <span>1 美元兑换人民币</span>
            <Input aria-label="美元兑人民币汇率" type="number" step="any" min="0" value={draft}
              aria-invalid={!!error} onChange={(e) => { setDraft(e.target.value); setError(""); }} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">按此汇率统一换算当前及历史费用，非历史结算汇率。设置保存在当前浏览器。</p>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" className="w-full">保存汇率</Button>
        </form>
      </PopoverContent>
    </Popover>
  </div>;
}
