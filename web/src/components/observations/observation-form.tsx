"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addObservation } from "@/lib/actions";
import { observationSchema, type ObservationInput } from "@/lib/schemas";

export function ObservationForm({ today, themeId }: { today: string; themeId: string }) {
  const [pending, startTransition] = React.useTransition();
  const form = useForm<ObservationInput>({
    resolver: zodResolver(observationSchema),
    defaultValues: { themeId, date: today, light: "red", note: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const res = await addObservation(values);
      if (res.ok) {
        toast.success(res.message);
        form.reset({ themeId, date: today, light: values.light, note: "" });
      } else {
        toast.error(res.message);
      }
    });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新增核对</CardTitle>
        <CardDescription>保存时自动抓取当前 15 个信号的当前值作为快照</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
          <input type="hidden" {...form.register("themeId")} />
          <div className="space-y-2">
            <Label htmlFor="obs-date">日期</Label>
            <Input id="obs-date" type="date" {...form.register("date")} />
            {form.formState.errors.date && (
              <p className="text-xs text-red-600">{form.formState.errors.date.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>信号灯</Label>
            <Select
              value={form.watch("light")}
              onValueChange={(v) => form.setValue("light", v as ObservationInput["light"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="red">红灯</SelectItem>
                <SelectItem value="yellow">黄灯</SelectItem>
                <SelectItem value="green">绿灯</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="obs-note">备注</Label>
            <Textarea id="obs-note" rows={1} placeholder="本次核对的结论…" {...form.register("note")} />
          </div>
          <Button type="submit" disabled={pending} className="sm:mb-0.5">
            {pending ? "保存中…" : "保存核对"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
