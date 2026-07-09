import type { ChatStatus } from "@/lib/chat/types";

export function PageHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

export function NoSiteSelected() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <p className="text-sm font-medium text-slate-700">No site selected</p>
      <p className="mt-1 text-sm text-slate-500">Choose a site from the switcher above to view its data.</p>
    </div>
  );
}

export function PageError({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{message}</div>
  );
}

const STATUS_STYLE: Record<ChatStatus, string> = {
  open: "bg-amber-100 text-amber-700",
  "awaiting-customer": "bg-sky-100 text-sky-700",
  resolved: "bg-emerald-100 text-emerald-700",
};

export function StatusBadge({ status }: { status: ChatStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status}</span>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white ${className}`}>{children}</div>;
}
