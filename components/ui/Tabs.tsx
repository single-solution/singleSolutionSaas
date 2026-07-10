"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KeyboardEvent, ReactNode, useRef } from "react";

import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ElementType;
  content: ReactNode;
}

export function Tabs({
  tabs,
  defaultTabId,
  className,
  queryKey = "tab",
}: {
  tabs: TabItem[];
  defaultTabId?: string;
  className?: string;
  queryKey?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedId = searchParams.get(queryKey);
  const activeId = tabs.some((tab) => tab.id === requestedId)
    ? requestedId!
    : (defaultTabId ?? tabs[0]?.id ?? "");

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  function selectTab(tabId: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (tabId === (defaultTabId ?? tabs[0]?.id)) {
      next.delete(queryKey);
    } else {
      next.set(queryKey, tabId);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const lastIndex = tabs.length - 1;
    const nextIndex =
      event.key === "ArrowRight"
        ? index === lastIndex
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? lastIndex
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null;
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    selectTab(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  if (!activeTab) {
    return null;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="mb-5 overflow-x-auto border-b border-line no-scrollbar">
        <div
          className="-mb-px flex space-x-6"
          role="tablist"
          aria-label="Page sections"
        >
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeId;
            return (
              <button
                key={tab.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                id={`${queryKey}-tab-${tab.id}`}
                role="tab"
                aria-controls={`${queryKey}-panel-${tab.id}`}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={cn(
                  "group inline-flex items-center gap-2 rounded-t border-b-2 px-1 py-3.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  isActive
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-ink-secondary hover:border-line hover:text-ink",
                )}
              >
                {tab.icon ? (
                  <tab.icon
                    className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      isActive
                        ? "text-brand-600"
                        : "text-ink-faint group-hover:text-ink-secondary",
                    )}
                    aria-hidden="true"
                  />
                ) : null}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={`${queryKey}-panel-${activeTab.id}`}
        role="tabpanel"
        aria-labelledby={`${queryKey}-tab-${activeTab.id}`}
        tabIndex={0}
        className="animate-fade-in focus:outline-none motion-reduce:animate-none"
      >
        {activeTab.content}
      </div>
    </div>
  );
}
