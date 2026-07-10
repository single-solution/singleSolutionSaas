import { Suspense } from "react";

import { OverviewClient } from "./OverviewClient";
import { PageLoader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading overview..." />}>
      <OverviewClient />
    </Suspense>
  );
}
