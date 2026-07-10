"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plug, Send } from "lucide-react";

import {
  adminApi,
  type AdminSettings,
  type WebhookDeliveryRow,
} from "@/lib/admin/adminApiClient";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  InlineNote,
  ListSkeleton,
  NoSiteSelected,
  PageError,
  PageHeading,
  TableEmptyRow,
} from "@/components/admin/ui";

export function WebhooksClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, webhooksResult] = await Promise.all([
        adminApi.getSettings(siteId),
        adminApi.listWebhooks(siteId),
      ]);
      setSettings(settingsResult.settings);
      setDeliveries(webhooksResult.deliveries);
    } catch {
      setError("Could not load webhook data.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTest() {
    if (!siteId) return;
    setTesting(true);
    setNote(null);
    setError(null);
    try {
      const result = await adminApi.testWebhook(siteId);
      setNote(
        result.delivered
          ? "Test delivered successfully."
          : "Test sent but the endpoint did not return success.",
      );
      await load();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Test failed.",
      );
    } finally {
      setTesting(false);
    }
  }

  if (!siteId) {
    return <NoSiteSelected />;
  }

  return (
    <div className="admin-page-stack">
      <PageHeading
        title="Webhooks"
        subtitle="Outbound notifications and delivery diagnostics."
      />
      {error ? <PageError message={error} onRetry={() => void load()} /> : null}
      {note ? (
        <InlineNote tone={note.includes("successfully") ? "success" : "info"}>
          {note}
        </InlineNote>
      ) : null}

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--ink)]">Endpoint</p>
          <p className="truncate text-[13px] text-[var(--ink-muted)]">
            {settings?.webhookUrl || "Not configured (set it under Assistant)."}
          </p>
        </div>
        <Button
          onClick={() => void handleTest()}
          disabled={!settings?.webhookUrl}
          loading={testing}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Send test
        </Button>
      </Card>

      <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>Code</th>
              <th>Duration</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableEmptyRow colSpan={5}>
                <ListSkeleton rows={3} />
              </TableEmptyRow>
            ) : deliveries.length === 0 ? (
              <TableEmptyRow colSpan={5}>
                <EmptyState
                  icon={Plug}
                  title="No deliveries yet"
                  description="Webhook events will appear here after the first notification."
                />
              </TableEmptyRow>
            ) : (
              deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="font-medium text-[var(--ink)]">
                    {delivery.event}
                  </td>
                  <td>
                    <Badge
                      tone={
                        delivery.status === "success" ? "success" : "danger"
                      }
                    >
                      {delivery.status}
                    </Badge>
                    {delivery.error ? (
                      <span className="ml-2 text-xs text-[var(--danger)]">
                        {delivery.error}
                      </span>
                    ) : null}
                  </td>
                  <td>{delivery.statusCode ?? "-"}</td>
                  <td>{delivery.durationMs}ms</td>
                  <td>{new Date(delivery.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
