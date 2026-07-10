import { Skeleton } from "@/components/ui/Skeleton";

export const DETAIL_FIRST_MAX_COUNT = 3;

function PageHeaderSkeleton({ withAction = false }: { withAction?: boolean }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {withAction ? <Skeleton className="h-9 w-28 rounded-md" /> : null}
    </div>
  );
}

function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      className={
        count === 3
          ? "grid grid-cols-2 gap-3 lg:grid-cols-3"
          : "grid grid-cols-2 gap-3 lg:grid-cols-4"
      }
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="rounded-lg border border-line bg-surface p-3.5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="size-7 rounded-md" />
          </div>
          <Skeleton className="mt-3 h-7 w-16" />
          <Skeleton className="mt-1 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

function FilterBarSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-subtle/50 p-3 sm:flex-row sm:items-center">
      <Skeleton className="h-10 flex-1 rounded-md" />
      <Skeleton className="h-10 w-36 rounded-md" />
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

function ResourceGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col rounded-xl border border-line bg-surface p-5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-10 w-full" />
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
            <Skeleton className="mx-auto h-8 w-10" />
            <Skeleton className="mx-auto h-8 w-10" />
            <Skeleton className="mx-auto h-8 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailFirstRowsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-sm lg:flex-row lg:items-center"
        >
          <div className="flex min-w-0 items-center gap-3 lg:w-64">
            <Skeleton className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
          </div>
          <div className="flex gap-2 lg:shrink-0">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

function TabsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-24 rounded-md" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    </div>
  );
}

function ProductWorkspaceSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 rounded-xl border border-line bg-surface-subtle/50 p-2">
        <Skeleton className="h-12 w-40 rounded-md" />
        <Skeleton className="h-12 w-40 rounded-md" />
      </div>
      <div className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-16 rounded-none" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
        <Skeleton className="h-44 rounded-xl" />
      </div>
    </div>
  );
}

export function DashboardAdminSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-md" />
      </div>
      <StatCardsSkeleton count={4} />
      <ResourceGridSkeleton count={4} />
    </div>
  );
}

export function DashboardMerchantSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>
      <StatCardsSkeleton count={3} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-line bg-surface p-5 shadow-sm">
          <Skeleton className="mb-4 h-5 w-32" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-md" />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
          <Skeleton className="mb-4 h-5 w-24" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-24" />
        <DetailFirstRowsSkeleton rows={2} />
      </div>
    </div>
  );
}

export function MerchantDirectorySkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-md" />
      </div>
      <StatCardsSkeleton count={4} />
      <FilterBarSkeleton />
      <ResourceGridSkeleton count={6} />
    </div>
  );
}

export function MerchantDetailSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <PageHeaderSkeleton withAction />
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 border-b border-line pb-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-28 rounded-md" />
          ))}
        </div>
        <MerchantOverviewSkeleton />
      </div>
    </div>
  );
}

export function MerchantOverviewSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true" aria-busy="true">
      <StatCardsSkeleton count={4} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
            <Skeleton className="mt-2 h-4 w-1/2" />
          </div>
          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-2 h-4 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SiteDirectorySkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      <ResourceGridSkeleton count={4} />
    </div>
  );
}

export function SiteDetailSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <PageHeaderSkeleton withAction />
      <ProductsViewSkeleton detailFirst />
    </div>
  );
}

export function ProductCatalogSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
      <StatCardsSkeleton count={4} />
      <FilterBarSkeleton />
      <ResourceGridSkeleton count={4} />
    </div>
  );
}

export function ProductDetailSkeleton() {
  return (
    <div className="page-stack" aria-hidden="true" aria-busy="true">
      <PageHeaderSkeleton withAction />
      <TabsSkeleton />
    </div>
  );
}

export function ProductsViewSkeleton({
  detailFirst = false,
}: {
  detailFirst?: boolean;
}) {
  if (detailFirst) {
    return (
      <div aria-hidden="true" aria-busy="true">
        <ProductWorkspaceSkeleton />
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-line bg-surface p-5 shadow-sm"
      aria-hidden="true"
      aria-busy="true"
    >
      <div className="mb-4 space-y-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <ResourceGridSkeleton count={3} />
    </div>
  );
}

export function ProductConfigEditorSkeleton() {
  return (
    <div
      className="rounded-xl border border-line bg-surface p-5 shadow-sm"
      aria-hidden="true"
      aria-busy="true"
    >
      <div className="mb-4 space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Skeleton className="h-6 w-12 rounded-full" />
        <Skeleton className="h-6 w-28 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="space-y-5">
        {Array.from({ length: 2 }).map((_, sectionIndex) => (
          <div key={sectionIndex} className="rounded-md border border-line p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, fieldIndex) => (
                <div key={fieldIndex} className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
    </div>
  );
}

export function MerchantActivitySkeleton({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div
        className="divide-y divide-line rounded-md border border-line bg-surface"
        aria-hidden="true"
        aria-busy="true"
      >
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="space-y-1.5 px-3 py-2">
            <Skeleton className="h-3.5 w-full max-w-[12rem]" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-line bg-surface p-5 shadow-sm h-fit"
      aria-hidden="true"
      aria-busy="true"
    >
      <div className="mb-4 space-y-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-56 max-w-full" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="rounded-md border border-line px-4 py-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConversationsSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
      aria-hidden="true"
      aria-busy="true"
    >
      <div className="grid min-h-[32rem] grid-cols-1 md:grid-cols-[20rem_1fr]">
        <aside className="flex flex-col border-b border-line md:border-b-0 md:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-7 w-14 rounded-md" />
              ))}
            </div>
            <Skeleton className="size-7 rounded-md" />
          </div>
          <div className="space-y-0 divide-y divide-line">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="space-y-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="size-5 rounded-full" />
                </div>
                <Skeleton className="h-3 w-full" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        </aside>
        <section className="flex min-h-[32rem] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
            <div className="space-y-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="flex-1 space-y-3 bg-surface-subtle/40 px-5 py-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton
                key={index}
                className={`h-16 rounded-2xl ${index % 2 === 0 ? "w-3/5" : "ml-auto w-2/5"}`}
              />
            ))}
          </div>
          <div className="flex items-end gap-2 border-t border-line px-4 py-3">
            <Skeleton className="h-11 flex-1 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
        </section>
      </div>
    </div>
  );
}
