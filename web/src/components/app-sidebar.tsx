import { Separator } from "@/components/ui/separator";
import { Brand, NavLinks } from "@/components/nav";

export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar md:flex">
      <Brand />
      <Separator className="bg-sidebar-border" />
      <div className="flex-1 overflow-y-auto py-3">
        <NavLinks />
      </div>
      <div className="px-5 py-4 text-xs text-muted-foreground">
        个人研究框架，不构成投资建议
      </div>
    </aside>
  );
}
