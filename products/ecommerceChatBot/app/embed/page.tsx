/**
 * Hosted embed target. The loader (`/embed.js`) drops an iframe pointing here.
 *
 * Framing is gated per token: the embedding site's host (from Referer) must be in
 * the token's allowed domains. This is browser-honest for real embeds — a site
 * cannot forge the Referer of the iframe document to another origin — so a
 * stolen token cannot be framed on an unlisted site. Fails closed in production
 * when the host is missing or not allowed.
 */

import { headers } from "next/headers";

import { LiveChatWidget } from "@/components/chat/LiveChatWidget";
import { isHostAllowed } from "@/lib/api/origin";
import { getChatSettings } from "@/lib/chat/settings";
import { fetchPreviewConfig, verifyProductToken } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

function hostOf(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isFramingAllowed(refererHost: string | null, selfHost: string | null, allowedDomains: string[]): boolean {
  if (refererHost && selfHost && refererHost === selfHost) {
    return true;
  }
  if (!refererHost) {
    return process.env.NODE_ENV !== "production";
  }
  return isHostAllowed(refererHost, allowedDomains);
}

export default async function EmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; preview?: string }>;
}) {
  const { token, preview } = await searchParams;
  const transparent = <style>{`html,body{background:transparent!important;margin:0}`}</style>;

  // Preview mode: the portal opens this in an iframe with a short-lived, signed
  // preview token. The token is verified server-to-server, so framing is trusted
  // and we render an appearance-only preview of the draft config (no chat calls).
  if (preview) {
    const draft = await fetchPreviewConfig(preview);
    if (!draft) {
      return transparent;
    }
    const settings = getChatSettings(draft.config);
    return (
      <>
        {transparent}
        <LiveChatWidget previewSettings={settings} />
      </>
    );
  }

  if (!token) {
    return transparent;
  }

  const entitlement = await verifyProductToken(token);
  if (!entitlement) {
    return transparent;
  }

  const requestHeaders = await headers();
  const refererHost = hostOf(requestHeaders.get("referer"));
  const selfHost = requestHeaders.get("host")?.split(":")[0]?.toLowerCase() ?? null;
  if (!isFramingAllowed(refererHost, selfHost, entitlement.allowedDomains)) {
    return transparent;
  }

  return (
    <>
      {transparent}
      <LiveChatWidget productToken={token} />
    </>
  );
}
