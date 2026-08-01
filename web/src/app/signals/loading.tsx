import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-96 rounded-lg" />
      <Skeleton className="h-72 w-full rounded-lg" />
    </div>
  );
}
