import { AlertTriangle, LucideIcon } from "lucide-react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { DetailSkeleton, ListSkeleton } from "@/components/ui/Skeleton";

export function PageLoading({
  variant = "detail",
}: {
  variant?: "detail" | "list";
}) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {variant === "list" ? <ListSkeleton /> : <DetailSkeleton />}
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert tone="danger" title="Something went wrong">
      {message}
      {onRetry ? (
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

export function PageEmpty({
  icon = AlertTriangle,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={action}
    />
  );
}
