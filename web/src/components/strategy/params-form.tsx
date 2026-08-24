"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveStrategyParams } from "@/lib/actions";

/** 策略参数编辑：JSON + 理由，追加为新版本（不改旧版本） */
export function StrategyParamsForm({
  themeId,
  currentJson,
}: {
  themeId: string;
  currentJson: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [json, setJson] = React.useState(currentJson);
  const [note, setNote] = React.useState("");

  const onSave = () => {
    startTransition(async () => {
      const res = await saveStrategyParams({ themeId, paramsJson: json, note });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="sp-json">参数 JSON（须含 mom_days / ma_days / top_n 数字键）</Label>
        <Textarea
          id="sp-json"
          rows={9}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className="mt-1 font-mono text-[13px] leading-6"
        />
      </div>
      <div>
        <Label htmlFor="sp-note">修改理由（留痕）</Label>
        <Input
          id="sp-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="为什么改参数"
          className="mt-1"
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={onSave} disabled={pending}>
          {pending ? "保存中…" : "保存为新版本"}
        </Button>
      </div>
    </div>
  );
}
