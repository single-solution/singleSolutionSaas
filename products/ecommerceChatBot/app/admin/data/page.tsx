import { Suspense } from "react";

import { DataClient } from "./DataClient";

export const dynamic = "force-dynamic";

export default function AdminDataPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading...</p>}>
      <DataClient />
    </Suspense>
  );
}
