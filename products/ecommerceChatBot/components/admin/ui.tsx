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
}: {
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
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

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[var(--line)] motion-reduce:animate-none",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center justify-between rounded-lg border border-[var(--line)] px-4 py-3"
        >
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
    <div className="admin-page-stack" aria-hidden="true">
      <Skeleton className="h-5 w-56" />
      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-[var(--shadow-card)]">
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-[var(--shadow-card)]">
          <Skeleton className="mb-4 h-6 w-24" />
          <ListSkeleton />
        </div>
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-[var(--shadow-card)]">
          <Skeleton className="mb-4 h-6 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>
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
}: {
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-8 text-center text-[var(--ink-faint)]"
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
