import { cn } from "@/lib/cn";

export function Spinner({ size = "md", className }: { size?: "sm" | "md"; className?: string }) {
  const sizeClass = size === "sm" ? "h-4 w-4 border-2" : "h-5 w-5 border-2";
  return (
    <span
      className={cn("inline-block animate-spin rounded-full border-current border-t-transparent", sizeClass, className)}
      aria-hidden="true"
    />
  );
}

export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-ink-muted" role="status">
      <Spinner />
      <span className="text-sm">{label}</span>
    </div>
  );
}
