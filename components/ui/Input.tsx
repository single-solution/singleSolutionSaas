import { type InputHTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, error, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-md border bg-surface px-3 text-[13px] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors placeholder:text-ink-faint",
        "hover:border-line-strong",
        "focus-visible:border-brand-600 focus-visible:shadow-focus",
        error ? "border-danger focus-visible:border-danger focus-visible:shadow-[0_0_0_3px_rgb(220_38_38/0.2)]" : "border-line",
        "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-faint",
        className,
      )}
      {...props}
    />
  );
});
