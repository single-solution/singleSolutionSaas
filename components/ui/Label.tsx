import { type LabelHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("text-sm font-medium text-ink-secondary", className)} {...props}>
      {children}
    </label>
  );
}
