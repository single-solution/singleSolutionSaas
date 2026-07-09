import { Suspense } from "react";

import { AssistantClient } from "./AssistantClient";

export const dynamic = "force-dynamic";

export default function AdminAssistantPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading...</p>}>
      <AssistantClient />
    </Suspense>
  );
}
