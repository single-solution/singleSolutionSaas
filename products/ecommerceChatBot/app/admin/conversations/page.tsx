import { Suspense } from "react";

import { ConversationsClient } from "./ConversationsClient";
import { PageLoader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminConversationsPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading conversations..." />}>
      <ConversationsClient />
    </Suspense>
  );
}
