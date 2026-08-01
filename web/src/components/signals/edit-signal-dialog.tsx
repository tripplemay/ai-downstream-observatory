"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { updateSignal } from "@/lib/actions";
import { signalUpdateSchema, type SignalUpdateInput } from "@/lib/schemas";
import { validStatuses } from "@/lib/seed";
import type { Signal } from "@/lib/queries";

export function EditSignalDialog({
  signal,
  open,
  onOpenChange,
}: {
  signal: Signal | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const form = useForm<SignalUpdateInput>({
    resolver: zodResolver(signalUpdateSchema),
    values: signal
      ? {
          id: signal.id,
          status: signal.status,
          current_value: signal.current_value,
          note: signal.note,
        }
      : undefined,
  });

  if (!signal) return null;
  const statuses = validStatuses(signal.layer);

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const res = await updateSignal(values);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
      } else {
        toast.error(res.message);
      }
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            编辑信号 {signal.id} · {signal.name}
          </DialogTitle>
          <DialogDescription>{signal.trigger_cond}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <input type="hidden" {...form.register("id")} />
          <div className="space-y-2">
            <Label>状态</Label>
            <Select
              value={form.watch("status")}
              onValueChange={(v) => form.setValue("status", v, { shouldValidate: true })}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择状态" />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.status && (
              <p className="text-xs text-red-600">{form.formState.errors.status.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sig-value">当前值</Label>
            <Input id="sig-value" {...form.register("current_value")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sig-note">备注</Label>
            <Textarea id="sig-note" rows={3} {...form.register("note")} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
