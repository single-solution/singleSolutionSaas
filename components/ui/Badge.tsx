import { cn } from "@/lib/cn";

const toneStyles = {
  neutral: "bg-surface-subtle text-ink-secondary ring-line",
  brand: "bg-accent-soft text-accent ring-accent-border",
  success: "bg-success-soft text-success ring-success-border",
  danger: "bg-danger-soft text-danger ring-danger-border",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof toneStyles;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        toneStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
