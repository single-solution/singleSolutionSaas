"use client";

import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
} from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";

import type { ChatStatus } from "@/lib/chat/types";
import { cn } from "@/components/admin/cn";

const buttonVariants = {
  primary:
    "bg-[var(--brand-800)] text-white hover:bg-[var(--brand-900)] active:bg-[var(--brand-900)] disabled:bg-[var(--brand-600)]/50 shadow-[0_1px_2px_rgba(0,0,0,0.05)]",
  secondary:
    "bg-[var(--surface-subtle)] text-[var(--ink)] hover:bg-[var(--line)] active:bg-[var(--line-strong)] disabled:text-[var(--ink-faint)]",
  outline:
    "border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-subtle)] active:bg-[var(--line)] disabled:text-[var(--ink-faint)] shadow-[0_1px_2px_rgba(0,0,0,0.02)]",
  ghost:
    "text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] active:bg-[var(--line)] disabled:text-[var(--ink-faint)]",
  danger:
    "bg-[var(--danger)] text-white hover:bg-red-700 active:bg-red-800 disabled:bg-red-300 shadow-[0_1px_2px_rgba(0,0,0,0.05)]",
} as const;

const buttonSizes = {
  sm: "h-8 px-2.5 text-[12.5px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-5 text-sm",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
          buttonVariants[variant],
          buttonSizes[size],
          className,
        )}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <Spinner
            size="sm"
            className={
              variant === "primary" || variant === "danger"
                ? "text-white"
                : "text-[var(--brand-700)]"
            }
          />
        ) : null}
        {children}
      </button>
    );
  },
);

export function Spinner({
  size = "md",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  const sizeClass = size === "sm" ? "h-4 w-4 border-2" : "h-5 w-5 border-2";
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-current border-t-transparent motion-reduce:animate-none",
        sizeClass,
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-[var(--ink-muted)]"
      role="status"
    >
      <Spinner />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function PageHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-[13px] text-[var(--ink-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function NoSiteSelected() {
  return (
    <EmptyState
      icon={AlertCircle}
      title="No site selected"
      description="Choose a site from the switcher above to view its data."
    />
  );
}

const alertTones = {
  info: "border-[var(--line)] bg-[var(--surface-subtle)] text-[var(--ink-secondary)]",
  success:
    "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]",
  warning:
    "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]",
  danger:
    "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof alertTones;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        alertTones[tone],
        className,
      )}
      role="alert"
    >
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      <div className="text-[var(--ink-secondary)]">{children}</div>
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert tone="danger" title="Something went wrong">
      {message}
      {onRetry ? (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

const badgeTones = {
  neutral:
    "bg-[var(--surface-subtle)] text-[var(--ink-secondary)] ring-[var(--line)]",
  brand:
    "bg-[var(--accent-soft)] text-[var(--accent)] ring-[var(--accent-border)]",
  success:
    "bg-[var(--success-soft)] text-[var(--success)] ring-[var(--success-border)]",
  danger:
    "bg-[var(--danger-soft)] text-[var(--danger)] ring-[var(--danger-border)]",
  warning:
    "bg-[var(--warning-soft)] text-[var(--warning)] ring-[var(--warning-border)]",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ChatStatus, keyof typeof badgeTones> = {
  open: "warning",
  "awaiting-customer": "brand",
  resolved: "success",
};

const STATUS_LABEL: Record<ChatStatus, string> = {
  open: "Open",
  "awaiting-customer": "Awaiting customer",
  resolved: "Resolved",
};

export function StatusBadge({ status }: { status: ChatStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] transition-all duration-200 motion-reduce:transition-none md:p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-0.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">
          {title}
        </h2>
        {description ? (
          <p className="max-w-prose text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-subtle)] px-4 py-5 text-center">
        <Icon className="h-5 w-5 text-[var(--brand-700)]" aria-hidden="true" />
        <h3 className="mt-2 text-sm font-semibold text-[var(--ink)]">
          {title}
        </h3>
        <p className="mt-0.5 max-w-sm text-xs text-[var(--ink-muted)]">
          {description}
        </p>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-subtle)] px-6 py-10 text-center">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-[var(--brand-100)] text-[var(--brand-700)]">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-[var(--ink)]">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--ink-muted)]">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "warning" | "brand" | "success";
}) {
  const toneStyles = {
    neutral: "border-[var(--line)] bg-[var(--surface)]",
    warning: "border-[var(--warning-border)] bg-[var(--warning-soft)]",
    brand: "border-[var(--accent-border)] bg-[var(--accent-soft)]",
    success: "border-[var(--success-border)] bg-[var(--success-soft)]",
  };
  const valueStyles = {
    neutral: "text-[var(--ink)]",
    warning: "text-[var(--warning)]",
    brand: "text-[var(--brand-700)]",
    success: "text-[var(--success)]",
  };

  return (
    <div
      className={cn(
        "flex flex-col justify-between rounded-lg border p-3.5 shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-panel)] motion-reduce:transform-none motion-reduce:transition-none",
        toneStyles[tone],
      )}
    >
      <p className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</p>
      <div className="mt-3">
        <p
          className={cn(
            "text-xl font-semibold leading-none tracking-tight",
            valueStyles[tone],
          )}
        >
          {value}
        </p>
        {hint ? (
          <p className="mt-1 text-[11px] text-[var(--ink-faint)]">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[var(--line)] motion-reduce:animate-none",
        className,
      )}
      style={style}
      aria-hidden="true"
    />
  );
}

function PageHeadingSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
      {action ? <Skeleton className="h-9 w-28 shrink-0 rounded-md" /> : null}
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div
      className="admin-page-stack"
      role="status"
      aria-busy="true"
      aria-label="Loading overview"
    >
      <PageHeadingSkeleton />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3.5 shadow-[var(--shadow-card)]"
          >
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-6 w-12" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] md:p-5 lg:col-span-2">
          <Skeleton className="h-3.5 w-36" />
          <div className="mt-4 flex h-40 items-end gap-1">
            {Array.from({ length: 14 }).map((_, index) => (
              <Skeleton
                key={index}
                className="flex-1 rounded-t"
                style={{ height: `${30 + (index % 5) * 12}%` }}
              />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] md:p-5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="mt-4 h-10 w-24" />
          <Skeleton className="mt-2 h-3.5 w-full" />
        </div>
      </div>
    </div>
  );
}

export function AssistantFormSkeleton() {
  return (
    <div
      className="admin-page-stack max-w-3xl"
      role="status"
      aria-busy="true"
      aria-label="Loading assistant settings"
    >
      <PageHeadingSkeleton />
      {[
        { labelWidth: "w-28", rows: 5 },
        { labelWidth: "w-24", rows: 4 },
        { labelWidth: "w-32", rows: 3 },
      ].map((field, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className={cn("h-4", field.labelWidth)} />
          <Skeleton
            className="w-full rounded-md"
            style={{ height: `${field.rows * 1.5 + 1}rem` }}
          />
          <Skeleton className="h-3 w-4/5 max-w-md" />
        </div>
      ))}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-[4.5rem] w-full rounded-md" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] md:p-5">
        <div className="mb-4 space-y-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      </div>
      <Skeleton className="h-9 w-32 rounded-md" />
    </div>
  );
}

export function ConversationListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-[var(--line)]" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <li key={index} className="flex flex-col gap-1.5 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
          <Skeleton className="h-3 w-48 max-w-full" />
          <Skeleton className="h-2.5 w-24" />
        </li>
      ))}
    </ul>
  );
}

export function ConversationThreadSkeleton({
  messageCount = 3,
}: {
  messageCount?: number;
}) {
  return (
    <div
      className="flex max-h-[70vh] flex-col"
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] p-4">
        <div className="space-y-1">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>
      <div className="space-y-3 p-4">
        {Array.from({ length: messageCount }).map((_, index) => (
          <Skeleton
            key={index}
            className={cn(
              "h-14 rounded-lg",
              index % 2 === 0 ? "w-[70%]" : "ml-auto w-[60%]",
            )}
          />
        ))}
      </div>
      <div className="border-t border-[var(--line)] p-3">
        <div className="flex items-end gap-2">
          <Skeleton className="h-[3.25rem] flex-1 rounded-md" />
          <Skeleton className="h-9 w-20 shrink-0 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export function ConversationsPageSkeleton() {
  return (
    <div
      className="admin-page-stack"
      role="status"
      aria-busy="true"
      aria-label="Loading conversations"
    >
      <PageHeadingSkeleton />
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-md sm:w-64" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
          <ConversationListSkeleton />
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
          <ConversationThreadSkeleton />
        </div>
      </div>
    </div>
  );
}

const WEBHOOK_TABLE_COLUMNS = [
  "Event",
  "Status",
  "Code",
  "Duration",
  "When",
] as const;

export function WebhookTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true">
          <td>
            <Skeleton className="h-4 w-28" />
          </td>
          <td>
            <Skeleton className="h-5 w-16 rounded-md" />
          </td>
          <td>
            <Skeleton className="h-4 w-8" />
          </td>
          <td>
            <Skeleton className="h-4 w-12" />
          </td>
          <td>
            <Skeleton className="h-4 w-32" />
          </td>
        </tr>
      ))}
    </>
  );
}

export function WebhooksPageSkeleton() {
  return (
    <div
      className="admin-page-stack"
      role="status"
      aria-busy="true"
      aria-label="Loading webhooks"
    >
      <PageHeadingSkeleton action />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] md:p-5">
        <div className="min-w-0 space-y-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3.5 w-64 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 shrink-0 rounded-md" />
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
        <table className="admin-table">
          <thead>
            <tr>
              {WEBHOOK_TABLE_COLUMNS.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <WebhookTableSkeleton />
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DataTableSkeleton({
  columns = 5,
  rows = 4,
}: {
  columns?: number;
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <td key={columnIndex}>
              <Skeleton
                className="h-4"
                style={{
                  width: `${4 + ((rowIndex + columnIndex) % 4) * 2}rem`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function DataPageSkeleton() {
  return (
    <div
      className="admin-page-stack"
      role="status"
      aria-busy="true"
      aria-label="Loading raw data"
    >
      <PageHeadingSkeleton />
      <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
        <table className="admin-table">
          <thead>
            <tr>
              {Array.from({ length: 5 }).map((_, index) => (
                <th key={index}>
                  <Skeleton className="h-3 w-16" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <DataTableSkeleton />
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-14 rounded-md" />
      </div>
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "admin-input",
        error &&
          "border-[var(--danger)] focus-visible:border-[var(--danger)] focus-visible:shadow-[0_0_0_3px_rgb(220_38_38/0.2)]",
        className,
      )}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, error, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "admin-textarea",
          error &&
            "border-[var(--danger)] focus-visible:border-[var(--danger)] focus-visible:shadow-[0_0_0_3px_rgb(220_38_38/0.2)]",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  htmlFor,
  hint,
  optional,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-[var(--ink-secondary)]"
      >
        {label}
        {optional ? (
          <span className="font-normal text-[var(--ink-muted)]">
            {" "}
            (optional)
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-[var(--ink-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1 shadow-[var(--shadow-card)]"
    >
      {options.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors motion-reduce:transition-none",
              selected
                ? "bg-[var(--brand-800)] text-white shadow-sm"
                : "text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)]",
            )}
          >
            {option.replace(/-/g, " ")}
          </button>
        );
      })}
    </div>
  );
}

export function TableEmptyRow({
  colSpan,
  children,
  compact = false,
}: {
  colSpan: number;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={cn(
          "px-4 text-center text-[var(--ink-faint)]",
          compact ? "py-4" : "py-8",
        )}
      >
        {children}
      </td>
    </tr>
  );
}

export function InlineNote({
  tone = "info",
  children,
}: {
  tone?: "info" | "success";
  children: React.ReactNode;
}) {
  return (
    <Alert tone={tone === "success" ? "success" : "info"} className="py-2">
      {children}
    </Alert>
  );
}
