import { cn } from "@/lib/cn";

interface ProgressProps {
  value: number;
  max?: number;
  label: string;
  tone?: "brand" | "danger" | "success";
  className?: string;
}

export function Progress({
  value,
  max = 100,
  label,
  tone = "brand",
  className,
}: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((value / safeMax) * 100)),
  );
  const toneClass =
    tone === "danger"
      ? "bg-danger"
      : tone === "success"
        ? "bg-success"
        : "bg-brand-600";

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(value, safeMax)}
      aria-valuetext={`${percentage}%`}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-transform motion-reduce:transition-none",
          toneClass,
        )}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}
