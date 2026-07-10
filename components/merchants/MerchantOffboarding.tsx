"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Download, RotateCcw, Trash2 } from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantOffboardingSummary } from "@/lib/types";

const LIFECYCLE_LABELS: Record<MerchantOffboardingSummary["lifecycleStatus"], string> = {
  active: "Active",
  offboarding: "Offboarding",
  deletion_scheduled: "Deletion scheduled",
};

function humanizeExportStatus(status: string | null): string {
  if (!status) {
    return "Not requested";
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function MerchantOffboarding({ merchantId }: { merchantId: string }) {
  const toast = useToast();
  const [summary, setSummary] = useState<MerchantOffboardingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "suspend" | "export" | "restore" | "delete" | null
  >(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.getMerchantOffboarding(merchantId);
      setSummary(response.offboarding);
    } catch {
      setError("Could not load offboarding status.");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction() {
    if (!pendingAction) {
      return;
    }
    setActing(true);
    try {
      if (pendingAction === "suspend") {
        const response = await platformApi.startMerchantOffboarding(merchantId);
        setSummary(response.offboarding);
        toast.showSuccess("Merchant suspended", "Keys revoked and subscriptions archived.");
      }
      if (pendingAction === "export") {
        const response = await platformApi.requestMerchantExport(merchantId);
        setSummary(response.offboarding);
        toast.showSuccess("Export requested", "A tenant data export job was queued.");
      }
      if (pendingAction === "restore") {
        const response = await platformApi.restoreMerchant(merchantId);
        setSummary(response.offboarding);
        toast.showSuccess("Merchant restored", "Access can be re-enabled from subscriptions.");
      }
      if (pendingAction === "delete") {
        const response = await platformApi.scheduleMerchantDeletion(merchantId);
        setSummary(response.offboarding);
        toast.showSuccess(
          "Deletion scheduled",
          "Records remain until the cleanup processor runs.",
        );
      }
      setPendingAction(null);
    } catch (caughtError) {
      toast.showError(
        "Action failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again in a moment.",
      );
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-muted" aria-live="polite">Loading offboarding...</p>;
  }

  if (error) {
    return (
      <Alert tone="danger" title="Load failed">
        {error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  if (!summary) {
    return null;
  }

  const statusTone =
    summary.lifecycleStatus === "active"
      ? "success"
      : summary.lifecycleStatus === "deletion_scheduled"
        ? "danger"
        : "neutral";

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-ink-muted">Lifecycle status</p>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={statusTone}>
                {LIFECYCLE_LABELS[summary.lifecycleStatus]}
              </Badge>
              <span className="text-sm text-ink-secondary">
                {summary.retentionDays}-day retention window
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-ink-faint">Active subs</p>
              <p className="font-semibold text-ink">{summary.activeSubscriptions}</p>
            </div>
            <div>
              <p className="text-ink-faint">Active keys</p>
              <p className="font-semibold text-ink">{summary.activeTokens}</p>
            </div>
            <div>
              <p className="text-ink-faint">Export</p>
              <p className="font-semibold text-ink">
                {humanizeExportStatus(summary.exportStatus)}
              </p>
            </div>
            <div>
              <p className="text-ink-faint">Deletion eligible</p>
              <p className="font-semibold text-ink">
                {summary.deletionEligibleAt
                  ? new Date(summary.deletionEligibleAt).toLocaleDateString()
                  : "-"}
              </p>
            </div>
          </div>
        </div>
      </Card>

      <Alert tone="info" title="Staged offboarding only">
        These actions suspend access, revoke keys, queue exports, and schedule deletion. No
        immediate database drop happens here—the cleanup processor handles eligible records later
        while audit logs are preserved.
      </Alert>

      <div className="flex flex-wrap gap-2">
        {summary.lifecycleStatus === "active" ? (
          <Button
            variant="danger"
            className="min-h-11"
            onClick={() => setPendingAction("suspend")}
          >
            <Archive className="h-4 w-4" aria-hidden="true" />
            Suspend merchant access
          </Button>
        ) : null}
        {summary.lifecycleStatus !== "active" ? (
          <>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingAction("export")}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Request data export
            </Button>
            {summary.canRestore ? (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setPendingAction("restore")}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Restore within 30 days
              </Button>
            ) : null}
            {summary.canDelete ? (
              <Button
                variant="danger"
                className="min-h-11"
                onClick={() => setPendingAction("delete")}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Schedule deletion
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingAction === "suspend"}
        title="Suspend merchant access?"
        description="Active subscriptions will be suspended, keys revoked, and a 30-day retention window starts. You can restore within that window."
        confirmLabel="Suspend access"
        loading={acting}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void runAction()}
      />
      <ConfirmDialog
        open={pendingAction === "export"}
        title="Request tenant data export?"
        description="Queues an export job for this merchant's tenant data. Progress appears in the status panel above."
        confirmLabel="Request export"
        loading={acting}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void runAction()}
      />
      <ConfirmDialog
        open={pendingAction === "restore"}
        title="Restore merchant?"
        description="Clears the offboarding state so subscriptions and access can be re-enabled manually."
        confirmLabel="Restore merchant"
        loading={acting}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void runAction()}
      />
      <ConfirmDialog
        open={pendingAction === "delete"}
        title="Schedule permanent deletion?"
        description="Marks the merchant for deletion once retention ends. The cleanup processor removes eligible records later; audit history is retained."
        confirmLabel="Schedule deletion"
        loading={acting}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void runAction()}
      />
    </div>
  );
}
