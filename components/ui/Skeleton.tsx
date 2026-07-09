import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-line", className)} aria-hidden="true" />;
}

export function ListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true">
      <Skeleton className="h-5 w-56" />
      <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <Skeleton className="mb-4 h-6 w-24" />
          <ListSkeleton />
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <Skeleton className="mb-4 h-6 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
