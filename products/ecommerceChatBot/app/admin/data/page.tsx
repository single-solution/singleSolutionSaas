import { Suspense } from "react";

import { DataClient } from "./DataClient";
import { DataPageSkeleton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminDataPage() {
  return (
    <Suspense fallback={<DataPageSkeleton />}>
      <DataClient />
    </Suspense>
  );
}
