import { Suspense } from "react";

import { WebhooksClient } from "./WebhooksClient";

export const dynamic = "force-dynamic";

export default function AdminWebhooksPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading...</p>}>
      <WebhooksClient />
    </Suspense>
  );
}
