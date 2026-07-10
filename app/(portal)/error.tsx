"use client";

import { PageError } from "@/components/ui/PageState";

export default function PortalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageError
      message="This page could not be loaded. Try again without leaving your workspace."
      onRetry={reset}
    />
  );
}
