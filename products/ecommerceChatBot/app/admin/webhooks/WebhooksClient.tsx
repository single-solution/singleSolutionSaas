"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Send } from "lucide-react";

import { adminApi, type AdminSettings, type WebhookDeliveryRow } from "@/lib/admin/adminApiClient";
import { NoSiteSelected, PageError, PageHeading } from "@/components/admin/ui";

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
      const [settingsResult, webhooksResult] = await Promise.all([adminApi.getSettings(siteId), adminApi.listWebhooks(siteId)]);
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
      setNote(result.delivered ? "Test delivered successfully." : "Test sent but the endpoint did not return success.");
      await load();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  if (!siteId) {
    return <NoSiteSelected />;
  }

  return (
    <div className="space-y-5">
      <PageHeading title="Webhooks" subtitle="Outbound notifications and delivery diagnostics." />
      {error ? <PageError message={error} /> : null}
      {note ? <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{note}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">Endpoint</p>
          <p className="truncate text-sm text-slate-500">{settings?.webhookUrl || "Not configured (set it under Assistant)."}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing || !settings?.webhookUrl}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Send test
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2">Event</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Duration</th>
              <th className="px-4 py-2">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Loading...
                </td>
              </tr>
            ) : deliveries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  No deliveries yet.
                </td>
              </tr>
            ) : (
              deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-700">{delivery.event}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        delivery.status === "success" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {delivery.status}
                    </span>
                    {delivery.error ? <span className="ml-2 text-xs text-red-500">{delivery.error}</span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{delivery.statusCode ?? "-"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{delivery.durationMs}ms</td>
                  <td className="px-4 py-2.5 text-slate-500">{new Date(delivery.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
