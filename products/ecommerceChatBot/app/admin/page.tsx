import { Suspense } from "react";

import { OverviewClient } from "./OverviewClient";

export const dynamic = "force-dynamic";

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading...</p>}>
      <OverviewClient />
    </Suspense>
  );
}
