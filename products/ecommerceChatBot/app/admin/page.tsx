import { Suspense } from "react";

import { OverviewClient } from "./OverviewClient";
import { OverviewSkeleton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewClient />
    </Suspense>
  );
}
