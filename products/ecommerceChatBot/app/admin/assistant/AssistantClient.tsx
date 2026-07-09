"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { adminApi, type AdminSettings } from "@/lib/admin/adminApiClient";
import { NoSiteSelected, PageError, PageHeading } from "@/components/admin/ui";

function toLines(value: string[]): string {
  return value.join("\n");
}

function fromLines(value: string): string[] {
  return value
    .split(/[\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function AssistantClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [autoReplyRules, setAutoReplyRules] = useState("");
  const [cannedReplies, setCannedReplies] = useState("");
  const [escalationKeywords, setEscalationKeywords] = useState("");
  const [handoffMessage, setHandoffMessage] = useState("");
  const [fallbackMessage, setFallbackMessage] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function hydrate(next: AdminSettings) {
    setSettings(next);
    setAutoReplyRules(toLines(next.autoReplyRules));
    setCannedReplies(toLines(next.cannedReplies));
    setEscalationKeywords(toLines(next.escalationKeywords));
    setHandoffMessage(next.handoffMessage);
    setFallbackMessage(next.fallbackMessage);
    setWebhookUrl(next.webhookUrl);
    setWebhookSecret("");
  }

  useEffect(() => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    adminApi
      .getSettings(siteId)
      .then((result) => {
        if (active) hydrate(result.settings);
      })
      .catch(() => {
        if (active) setError("Could not load settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [siteId]);

  async function handleSave() {
    if (!siteId) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await adminApi.saveSettings(siteId, {
        autoReplyRules: fromLines(autoReplyRules),
        cannedReplies: fromLines(cannedReplies),
        escalationKeywords: fromLines(escalationKeywords),
        handoffMessage,
        fallbackMessage,
        webhookUrl,
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      });
      hydrate(result.settings);
      setSaved(true);
    } catch {
      setError("Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!siteId) {
    return <NoSiteSelected />;
  }
  if (loading) {
    return <p className="text-sm text-slate-500">Loading settings...</p>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeading title="Assistant tuning" subtitle="Advanced automation for this site. Overrides the portal defaults." />
      {error ? <PageError message={error} /> : null}
      {saved ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Saved.</p> : null}

      <FieldBlock label="Auto-reply rules" hint="One per line as pattern::reply (pattern is a case-insensitive regex).">
        <textarea
          value={autoReplyRules}
          onChange={(event) => setAutoReplyRules(event.target.value)}
          rows={5}
          className="admin-textarea"
          placeholder="refund|return::We offer a 30-day return policy."
        />
      </FieldBlock>

      <FieldBlock label="Canned replies" hint="Quick reply snippets, one per line (used by agents).">
        <textarea value={cannedReplies} onChange={(event) => setCannedReplies(event.target.value)} rows={4} className="admin-textarea" />
      </FieldBlock>

      <FieldBlock label="Escalation keywords" hint="One per line. Any match forces a human handoff.">
        <textarea value={escalationKeywords} onChange={(event) => setEscalationKeywords(event.target.value)} rows={3} className="admin-textarea" />
      </FieldBlock>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldBlock label="Handoff message" hint="Sent when a customer asks for a human.">
          <textarea value={handoffMessage} onChange={(event) => setHandoffMessage(event.target.value)} rows={3} className="admin-textarea" />
        </FieldBlock>
        <FieldBlock label="Fallback message" hint="Sent when no rule matches.">
          <textarea value={fallbackMessage} onChange={(event) => setFallbackMessage(event.target.value)} rows={3} className="admin-textarea" />
        </FieldBlock>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-800">Webhook</h3>
        <p className="mt-1 text-xs text-slate-500">Notified on new conversations and customer messages. Signed with the secret.</p>
        <div className="mt-3 space-y-3">
          <FieldBlock label="Webhook URL">
            <input
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://example.com/hooks/chatbot"
              className="admin-input"
            />
          </FieldBlock>
          <FieldBlock label="Webhook secret" hint={settings?.webhookSecretSet ? "A secret is set. Leave blank to keep it." : "Optional signing secret."}>
            <input
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder={settings?.webhookSecretSet ? "set - leave blank to keep" : "Not set"}
              className="admin-input"
            />
          </FieldBlock>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save settings"}
      </button>
    </div>
  );
}

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      {hint ? <p className="mb-1.5 text-xs text-slate-400">{hint}</p> : <div className="mb-1.5" />}
      {children}
    </div>
  );
}
