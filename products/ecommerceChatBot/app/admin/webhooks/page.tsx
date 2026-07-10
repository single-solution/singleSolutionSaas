import { Suspense } from "react";

import { WebhooksClient } from "./WebhooksClient";
import { PageLoader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminWebhooksPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading webhooks..." />}>
      <WebhooksClient />
    </Suspense>
  );
}
