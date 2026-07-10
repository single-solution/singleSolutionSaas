import Link from "next/link";

import { readAdminSession } from "@/lib/admin/session";
import { fetchProductSites } from "@/lib/platform/client";
import { AdminShell } from "@/components/admin/AdminShell";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await readAdminSession();

  if (!identity) {
    return (
      <div className="admin-app flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-8 text-center shadow-[var(--shadow-panel)]">
          <h1 className="text-lg font-semibold text-[var(--ink)]">
            Access denied
          </h1>
          <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
            This dashboard is only reachable from the Single Solution portal.
            Open it from the product page using &quot;Open advanced
            dashboard&quot;.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors hover:bg-[var(--surface-subtle)]"
          >
            Back to widget home
          </Link>
        </div>
      </div>
    );
  }

  const sites = await fetchProductSites(identity.productSlug);

  return (
    <AdminShell
      identity={{ name: identity.name, productSlug: identity.productSlug }}
      sites={sites}
    >
      {children}
    </AdminShell>
  );
}
