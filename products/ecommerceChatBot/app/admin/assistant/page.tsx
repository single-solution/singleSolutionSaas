import { Suspense } from "react";

import { AssistantClient } from "./AssistantClient";
import { AssistantFormSkeleton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default function AdminAssistantPage() {
  return (
    <Suspense fallback={<AssistantFormSkeleton />}>
      <AssistantClient />
    </Suspense>
  );
}
