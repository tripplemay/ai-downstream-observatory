"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addPoolItem, deletePoolItem, updatePoolItem } from "@/lib/actions";
import { poolItemSchema, type PoolItemInput } from "@/lib/schemas";
import type { PoolItem } from "@/lib/queries";

export function PoolManager({ items }: { items: PoolItem[] }) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PoolItem | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onDelete = (item: PoolItem) => {
    if (!window.confirm(`确认删除「${item.name}」？`)) return;
    startTransition(async () => {
      const res = await deletePoolItem(item.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          建仓候选标的；平台型基金优先，避免纯主题 ETF。
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> 添加标的
        </Button>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>代码</TableHead>
              <TableHead className="hidden md:table-cell">渠道</TableHead>
              <TableHead className="hidden md:table-cell">定位</TableHead>
              <TableHead className="hidden md:table-cell">备注</TableHead>
              <TableHead className="w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.name}</TableCell>
                <TableCell className="text-xs">{item.code || "—"}</TableCell>
                <TableCell className="hidden text-xs md:table-cell">{item.channel || "—"}</TableCell>
                <TableCell className="hidden text-xs md:table-cell">{item.position || "—"}</TableCell>
                <TableCell className="hidden max-w-56 md:table-cell">
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.note || "—"}</span>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" disabled={pending} onClick={() => onDelete(item)}>
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  标的池为空。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <PoolDialog item={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function PoolDialog({
  item,
  open,
  onOpenChange,
}: {
  item: PoolItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const form = useForm<PoolItemInput>({
    resolver: zodResolver(poolItemSchema),
    values: item
      ? {
          id: item.id,
          name: item.name,
          code: item.code,
          channel: item.channel,
          position: item.position,
          note: item.note,
        }
      : { name: "", code: "", channel: "", position: "", note: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const res = item ? await updatePoolItem(values) : await addPoolItem(values);
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
          <DialogTitle>{item ? "编辑标的" : "添加标的"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          {(["name", "code", "channel", "position", "note"] as const).map((field) => {
            const labels: Record<string, string> = {
              name: "名称 *",
              code: "代码",
              channel: "渠道",
              position: "定位",
              note: "备注",
            };
            return (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={`pool-${field}`}>{labels[field]}</Label>
                <Input id={`pool-${field}`} {...form.register(field)} />
                {form.formState.errors[field] && (
                  <p className="text-xs text-red-600">{form.formState.errors[field]?.message}</p>
                )}
              </div>
            );
          })}
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
