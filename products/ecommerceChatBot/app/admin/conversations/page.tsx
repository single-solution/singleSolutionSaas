import { Suspense } from "react";

import { ConversationsClient } from "./ConversationsClient";

export const dynamic = "force-dynamic";

export default function AdminConversationsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading...</p>}>
      <ConversationsClient />
    </Suspense>
  );
}
