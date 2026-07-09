import Link from "next/link";

import { readAdminSession } from "@/lib/admin/session";
import { fetchProductSites } from "@/lib/platform/client";
import { AdminShell } from "@/components/admin/AdminShell";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const identity = readAdminSession();

  if (!identity) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
          <p className="mt-2 text-sm text-slate-600">
            This dashboard is only reachable from the Single Solution portal. Open it from the product page using
            &quot;Open advanced dashboard&quot;.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Back to widget home
          </Link>
        </div>
      </div>
    );
  }

  const sites = await fetchProductSites(identity.productSlug);

  return (
    <AdminShell identity={{ name: identity.name, productSlug: identity.productSlug }} sites={sites}>
      {children}
    </AdminShell>
  );
}
