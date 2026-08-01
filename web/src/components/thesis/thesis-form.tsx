"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveThesis } from "@/lib/actions";

export function ThesisForm({ thesis, rules, themeId }: { thesis: string; rules: string; themeId: string }) {
  const [pending, startTransition] = React.useTransition();
  const [thesisVal, setThesisVal] = React.useState(thesis);
  const [rulesVal, setRulesVal] = React.useState(rules);

  const onSave = () => {
    startTransition(async () => {
      const res = await saveThesis({ themeId, thesis: thesisVal, rules: rulesVal });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">核心判断（Thesis）</CardTitle>
          <CardDescription>投资框架的假设与操作纪律</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="thesis" className="sr-only">
            Thesis
          </Label>
          <Textarea
            id="thesis"
            rows={12}
            value={thesisVal}
            onChange={(e) => setThesisVal(e.target.value)}
            className="font-mono text-[13px] leading-6"
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">建仓触发规则</CardTitle>
          <CardDescription>信号灯判定规则；季度 AI 分析会读取本规则</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="rules" className="sr-only">
            Rules
          </Label>
          <Textarea
            id="rules"
            rows={8}
            value={rulesVal}
            onChange={(e) => setRulesVal(e.target.value)}
            className="font-mono text-[13px] leading-6"
          />
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={onSave} disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
