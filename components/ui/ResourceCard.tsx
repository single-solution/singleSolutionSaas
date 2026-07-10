import Link from "next/link";
import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

interface ResourceCardProps {
  title: string;
  subtitle?: string;
  href?: string;
  icon: LucideIcon;
  badge?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function ResourceCard({
  title,
  subtitle,
  href,
  icon: Icon,
  badge,
  children,
  footer,
  className,
}: ResourceCardProps) {
  const heading = href ? (
    <Link
      href={href}
      className="block truncate font-semibold text-ink transition-colors hover:text-brand-700"
    >
      {title}
    </Link>
  ) : (
    <h3 className="truncate font-semibold text-ink">{title}</h3>
  );

  return (
    <article
      className={cn(
        "flex flex-col rounded-xl border border-line bg-surface p-5 shadow-card transition-shadow hover:shadow-panel",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            {heading}
            {subtitle ? (
              <p className="truncate text-sm text-ink-muted">{subtitle}</p>
            ) : null}
          </div>
        </div>
        {badge}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
      {footer ? (
        <div className="mt-auto border-t border-line pt-3">{footer}</div>
      ) : null}
    </article>
  );
}
