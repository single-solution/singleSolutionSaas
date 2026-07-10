import { Suspense } from "react";

import { AssistantClient } from "./AssistantClient";
import { PageLoader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminAssistantPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading assistant..." />}>
      <AssistantClient />
    </Suspense>
  );
}
