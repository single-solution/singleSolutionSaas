import type { ComponentType } from "react";

import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ComponentType<{ className?: string }>;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex flex-col justify-between rounded-lg border p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md",
        accent ? "border-accent-border bg-accent-soft" : "border-line bg-surface",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ink-muted">{label}</p>
        <span
          className={cn(
            "grid size-7 place-items-center rounded-md",
            accent ? "bg-accent text-white" : "bg-surface-subtle text-ink-secondary",
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
      <div className="mt-3">
        <p className="text-xl font-semibold leading-none tracking-tight text-ink">{value}</p>
        {hint ? <p className="mt-1 text-[11px] text-ink-faint">{hint}</p> : null}
      </div>
    </div>
  );
}
