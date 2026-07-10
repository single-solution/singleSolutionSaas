import { Suspense } from "react";

import { DataClient } from "./DataClient";
import { PageLoader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminDataPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading data..." />}>
      <DataClient />
    </Suspense>
  );
}
