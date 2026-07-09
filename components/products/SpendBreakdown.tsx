"use client";

import { PieChart, TrendingUp } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

import { formatCurrency } from "./currency";

export interface SpendEntry {
  id: string;
  label: string;
  amount: number;
  currency: string;
}

export function SpendBreakdown({
  entries,
  period,
  title,
}: {
  entries: SpendEntry[];
  period: string;
  title: string;
}) {
  const ranked = [...entries].filter((entry) => entry.amount > 0).sort((left, right) => right.amount - left.amount);
  const total = ranked.reduce((sum, entry) => sum + entry.amount, 0);
  const currency = ranked[0]?.currency ?? "USD";
  const max = Math.max(...ranked.map((entry) => entry.amount), 1);

  return (
    <Card className="h-full shadow-sm border-line bg-surface">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink-muted">
            <TrendingUp className="h-4 w-4 text-accent" aria-hidden="true" />
            {title}
          </p>
          <p className="mt-1 text-[26px] font-semibold leading-none tracking-tight text-ink">
            {formatCurrency(total, currency)}
          </p>
          <p className="mt-1 text-[11.5px] text-ink-faint">Estimated · {period}</p>
        </div>
      </div>

      <div className="mt-5">
        {ranked.length === 0 || total === 0 ? (
          <EmptyState
            icon={PieChart}
            title="No spend yet"
            description="Assign a plan to a product to see your estimated monthly spend."
          />
        ) : (
          <ul className="space-y-3.5">
            {ranked.map((entry) => {
              const pct = Math.round((entry.amount / max) * 100);
              const share = total > 0 ? Math.round((entry.amount / total) * 100) : 0;
              return (
                <li key={entry.id}>
                  <div className="mb-1.5 flex items-center justify-between text-[13px]">
                    <span className="truncate font-medium text-ink">{entry.label}</span>
                    <span className="shrink-0 text-ink-secondary">
                      {formatCurrency(entry.amount, entry.currency)}
                      <span className="ml-1.5 text-ink-faint">{share}%</span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-subtle">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-accent to-brand-500"
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
