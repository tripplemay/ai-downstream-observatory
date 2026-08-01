"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/signals/status-badge";
import { EditSignalDialog } from "@/components/signals/edit-signal-dialog";
import type { Signal } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface Group {
  key: string;
  label: string;
  signals: Signal[];
}

const LAYER_STYLE: Record<string, { tab: string; chip: string }> = {
  upstream: {
    tab: "data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400",
    chip: "bg-blue-500",
  },
  profit: {
    tab: "data-[state=active]:text-violet-600 dark:data-[state=active]:text-violet-400",
    chip: "bg-violet-500",
  },
  platform: {
    tab: "data-[state=active]:text-teal-600 dark:data-[state=active]:text-teal-400",
    chip: "bg-teal-500",
  },
  falsify: {
    tab: "data-[state=active]:text-red-600 dark:data-[state=active]:text-red-400",
    chip: "bg-red-500",
  },
};

const SHORT_LABEL: Record<string, string> = {
  upstream: "上游趋同",
  profit: "下游利润",
  platform: "平台归属",
  falsify: "证伪",
};

/** 各列响应式显隐：编号/编辑 ≥sm 显示（移动端整行可点击编辑），更新时间 ≥md 显示 */
const COL_CLASS: Record<string, string | undefined> = {
  id: "hidden sm:table-cell",
  updated_at: "hidden md:table-cell",
  actions: "hidden sm:table-cell",
};

export function SignalsTabs({ groups }: { groups: Group[] }) {
  const [editing, setEditing] = React.useState<Signal | null>(null);

  const columns: ColumnDef<Signal>[] = [
    {
      accessorKey: "id",
      header: "编号",
      cell: ({ row }) => <span className="font-mono text-xs font-semibold">{row.original.id}</span>,
      size: 60,
    },
    {
      accessorKey: "name",
      header: "信号",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">
            <span className="mr-1.5 font-mono text-xs font-semibold text-muted-foreground sm:hidden">
              {row.original.id}
            </span>
            {row.original.name}
          </div>
          <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={row.original.watch}>
            {row.original.watch}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <Button variant="ghost" size="sm" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>
          状态 <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
        </Button>
      ),
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "current_value",
      header: "当前值",
      cell: ({ row }) => (
        <span
          className="line-clamp-2 block max-w-36 text-sm sm:max-w-xs"
          title={row.original.current_value}
        >
          {row.original.current_value || "—"}
        </span>
      ),
    },
    {
      accessorKey: "updated_at",
      header: "更新时间",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">{row.original.updated_at || "—"}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" className="px-2" onClick={() => setEditing(row.original)}>
          <Pencil className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">编辑</span>
        </Button>
      ),
      size: 48,
    },
  ];

  return (
    <>
      <Tabs defaultValue={groups[0]?.key}>
        <TabsList>
          {groups.map((g) => (
            <TabsTrigger key={g.key} value={g.key} className={cn("gap-1.5", LAYER_STYLE[g.key]?.tab)}>
              <span className={cn("h-2 w-2 rounded-full", LAYER_STYLE[g.key]?.chip)} />
              {SHORT_LABEL[g.key] ?? g.label}
              <span className="text-xs text-muted-foreground">{g.signals.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {groups.map((g) => (
          <TabsContent key={g.key} value={g.key}>
            <p className="mb-2 text-xs text-muted-foreground">{g.label}</p>
            <SignalsTable columns={columns} data={g.signals} onEdit={setEditing} />
          </TabsContent>
        ))}
      </Tabs>
      <EditSignalDialog signal={editing} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
    </>
  );
}

function SignalsTable({
  columns,
  data,
  onEdit,
}: {
  columns: ColumnDef<Signal>[];
  data: Signal[];
  onEdit: (s: Signal) => void;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead key={h.id} className={COL_CLASS[h.column.id]}>
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => onEdit(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={COL_CLASS[cell.column.id]}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
