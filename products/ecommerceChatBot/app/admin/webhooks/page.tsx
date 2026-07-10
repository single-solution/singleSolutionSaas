import { Suspense } from "react";

import { WebhooksClient } from "./WebhooksClient";
import { WebhooksPageSkeleton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminWebhooksPage() {
  return (
    <Suspense fallback={<WebhooksPageSkeleton />}>
      <WebhooksClient />
    </Suspense>
  );
}
