"use client";

import Link from "next/link";
import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

export interface DropdownMenuItem {
  label: string;
  icon?: LucideIcon;
  href?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export function DropdownMenu({
  trigger,
  items,
  header,
  align = "right",
}: {
  trigger: (input: { open: boolean; toggle: () => void }) => ReactNode;
  items: DropdownMenuItem[];
  header?: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  function close() {
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = itemRefs.current.findIndex(
      (item) => item === document.activeElement,
    );
    const nextIndex =
      event.key === "ArrowDown"
        ? currentIndex < items.length - 1
          ? currentIndex + 1
          : 0
        : event.key === "ArrowUp"
          ? currentIndex > 0
            ? currentIndex - 1
            : items.length - 1
          : null;
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    itemRefs.current[nextIndex]?.focus();
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointer(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    }
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((current) => !current) })}
      {open ? (
        <div
          role="menu"
          onKeyDown={handleKeyDown}
          className={cn(
            "absolute z-dropdown mt-2 w-60 origin-top animate-fade-in rounded-xl border border-line bg-surface p-1.5 shadow-panel motion-reduce:animate-none",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {header ? (
            <div className="border-b border-line px-3 py-2.5">{header}</div>
          ) : null}
          <div className="mt-1">
            {items.map((item, index) => {
              const Icon = item.icon;
              const classes =
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50";
              if (item.href) {
                return (
                  <Link
                    key={item.label}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    href={item.href}
                    role="menuitem"
                    onClick={close}
                    className={classes}
                  >
                    {Icon ? (
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    ) : null}
                    {item.label}
                  </Link>
                );
              }
              return (
                <button
                  key={item.label}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    item.onSelect?.();
                    close();
                  }}
                  className={classes}
                >
                  {Icon ? (
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  ) : null}
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
