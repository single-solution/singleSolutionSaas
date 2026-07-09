import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/cn";

import { Spinner } from "./Spinner";

const variantStyles = {
  primary: "bg-brand-800 text-white hover:bg-brand-900 active:bg-brand-950 disabled:bg-brand-400 shadow-[0_1px_2px_rgba(0,0,0,0.05)]",
  secondary: "bg-surface-subtle text-ink hover:bg-line active:bg-line-strong disabled:text-ink-faint",
  outline: "border border-line bg-surface text-ink hover:bg-surface-subtle active:bg-line disabled:text-ink-faint shadow-[0_1px_2px_rgba(0,0,0,0.02)]",
  ghost: "text-ink-secondary hover:bg-surface-subtle active:bg-line disabled:text-ink-faint",
  danger: "bg-danger text-white hover:bg-red-700 active:bg-red-800 disabled:bg-red-300 shadow-[0_1px_2px_rgba(0,0,0,0.05)]",
} as const;

const sizeStyles = {
  sm: "h-8 px-2.5 text-[12.5px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-5 text-sm",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantStyles;
  size?: keyof typeof sizeStyles;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner size="sm" className={variant === "primary" || variant === "danger" ? "text-white" : "text-brand-700"} /> : null}
      {children}
    </button>
  );
});
