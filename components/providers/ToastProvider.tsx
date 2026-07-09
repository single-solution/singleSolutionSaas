"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type ToastTone = "success" | "error" | "info";

interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  showSuccess: (title: string, description?: string) => void;
  showError: (title: string, description?: string) => void;
  showInfo: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const toneStyles: Record<ToastTone, string> = {
  success: "border-success-border bg-success-soft text-success",
  error: "border-danger-border bg-danger-soft text-danger",
  info: "border-line bg-surface text-ink",
};

const autoDismissMs: Record<ToastTone, number> = {
  success: 3000,
  error: 8000,
  info: 4000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, tone, title, description }]);
      window.setTimeout(() => dismissToast(id), autoDismissMs[tone]);
    },
    [dismissToast],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      showSuccess: (title, description) => pushToast("success", title, description),
      showError: (title, description) => pushToast("error", title, description),
      showInfo: (title, description) => pushToast("info", title, description),
    }),
    [pushToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cn("pointer-events-auto rounded-lg border px-4 py-3 shadow-panel", toneStyles[toast.tone])}
          >
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.description ? <p className="mt-1 text-sm text-ink-secondary">{toast.description}</p> : null}
          </div>
        ))}
      </div>
      <div aria-live="assertive" className="sr-only">
        {toasts.filter((toast) => toast.tone === "error").map((toast) => toast.title).join(". ")}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
