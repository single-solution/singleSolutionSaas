import { Suspense } from "react";

import { ConversationsClient } from "./ConversationsClient";
import { ConversationsPageSkeleton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminConversationsPage() {
  return (
    <Suspense fallback={<ConversationsPageSkeleton />}>
      <ConversationsClient />
    </Suspense>
  );
}
