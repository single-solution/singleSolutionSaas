"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { adminApi, type AdminSettings } from "@/lib/admin/adminApiClient";
import {
  Button,
  Card,
  CardHeader,
  DetailSkeleton,
  Field,
  InlineNote,
  Input,
  NoSiteSelected,
  PageError,
  PageHeading,
  Textarea,
} from "@/components/admin/ui";

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

  const load = useCallback(() => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    adminApi
      .getSettings(siteId)
      .then((result) => hydrate(result.settings))
      .catch(() => setError("Could not load settings."))
      .finally(() => setLoading(false));
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

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
        ...(webhookSecret.trim()
          ? { webhookSecret: webhookSecret.trim() }
          : {}),
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
    return <DetailSkeleton />;
  }

  return (
    <div className="admin-page-stack max-w-3xl">
      <PageHeading
        title="Assistant tuning"
        subtitle="Advanced automation for this site. Overrides the portal defaults."
      />
      {error ? <PageError message={error} onRetry={load} /> : null}
      {saved ? <InlineNote tone="success">Settings saved.</InlineNote> : null}

      <Field
        label="Auto-reply rules"
        htmlFor="auto-reply-rules"
        hint="One per line as pattern::reply (pattern is a case-insensitive regex)."
      >
        <Textarea
          id="auto-reply-rules"
          value={autoReplyRules}
          onChange={(event) => setAutoReplyRules(event.target.value)}
          rows={5}
          placeholder="refund|return::We offer a 30-day return policy."
        />
      </Field>

      <Field
        label="Canned replies"
        htmlFor="canned-replies"
        hint="Quick reply snippets, one per line (used by agents)."
      >
        <Textarea
          id="canned-replies"
          value={cannedReplies}
          onChange={(event) => setCannedReplies(event.target.value)}
          rows={4}
        />
      </Field>

      <Field
        label="Escalation keywords"
        htmlFor="escalation-keywords"
        hint="One per line. Any match forces a human handoff."
      >
        <Textarea
          id="escalation-keywords"
          value={escalationKeywords}
          onChange={(event) => setEscalationKeywords(event.target.value)}
          rows={3}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Handoff message"
          htmlFor="handoff-message"
          hint="Sent when a customer asks for a human."
        >
          <Textarea
            id="handoff-message"
            value={handoffMessage}
            onChange={(event) => setHandoffMessage(event.target.value)}
            rows={3}
          />
        </Field>
        <Field
          label="Fallback message"
          htmlFor="fallback-message"
          hint="Sent when no rule matches."
        >
          <Textarea
            id="fallback-message"
            value={fallbackMessage}
            onChange={(event) => setFallbackMessage(event.target.value)}
            rows={3}
          />
        </Field>
      </div>

      <Card>
        <CardHeader
          title="Webhook"
          description="Notified on new conversations and customer messages. Signed with the secret."
        />
        <div className="space-y-3">
          <Field label="Webhook URL" htmlFor="webhook-url">
            <Input
              id="webhook-url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://example.com/hooks/chatbot"
            />
          </Field>
          <Field
            label="Webhook secret"
            htmlFor="webhook-secret"
            hint={
              settings?.webhookSecretSet
                ? "A secret is set. Leave blank to keep it."
                : "Optional signing secret."
            }
            optional={!settings?.webhookSecretSet}
          >
            <Input
              id="webhook-secret"
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder={
                settings?.webhookSecretSet
                  ? "set - leave blank to keep"
                  : "Not set"
              }
            />
          </Field>
        </div>
      </Card>

      <Button type="button" onClick={() => void handleSave()} loading={saving}>
        {saving ? "Saving..." : "Save settings"}
      </Button>
    </div>
  );
}
