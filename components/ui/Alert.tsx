import { cn } from "@/lib/cn";

const toneStyles = {
  info: "border-line bg-surface-subtle text-ink-secondary",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-danger-border bg-danger-soft text-danger",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof toneStyles;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border px-4 py-3 text-sm", toneStyles[tone], className)} role="alert">
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      <div className="text-ink-secondary">{children}</div>
    </div>
  );
}
