"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/cn";

interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "role"
> {
  checked: boolean;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch({ checked, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-brand-600" : "bg-line-strong",
          className,
        )}
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn(
            "block size-5 rounded-full bg-surface shadow-card transition-transform",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    );
  },
);
