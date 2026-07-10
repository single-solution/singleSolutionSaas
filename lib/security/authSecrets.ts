import type { Environment } from "@/lib/env";
import { isProduction } from "@/lib/utils";

function trimSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requireSecretInProduction(
  name: string,
  value: string | undefined,
  environment: Environment,
): string {
  const trimmed = trimSecret(value);
  if (trimmed) {
    return trimmed;
  }
  if (isProduction(environment)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return "";
}

/**
 * Development-only fallback when a dedicated signing secret is unset.
 * Never used in production.
 */
function developmentFallback(environment: Environment, dedicated: string | undefined): string {
  const trimmed = trimSecret(dedicated);
  if (trimmed) {
    return trimmed;
  }
  if (isProduction(environment)) {
    return "";
  }
  return environment.JWT_SECRET;
}

export function loadPreviewSigningSecret(environment: Environment): string {
  const dedicated = requireSecretInProduction(
    "PREVIEW_SIGNING_SECRET",
    environment.PREVIEW_SIGNING_SECRET,
    environment,
  );
  const resolved = dedicated || developmentFallback(environment, environment.PREVIEW_SIGNING_SECRET);
  if (!resolved) {
    throw new Error("Missing required environment variable: PREVIEW_SIGNING_SECRET");
  }
  return resolved;
}

export function loadSsoSigningSecret(environment: Environment): string {
  const dedicated = requireSecretInProduction(
    "SSO_SIGNING_SECRET",
    environment.SSO_SIGNING_SECRET,
    environment,
  );
  const resolved = dedicated || developmentFallback(environment, environment.SSO_SIGNING_SECRET);
  if (!resolved) {
    throw new Error("Missing required environment variable: SSO_SIGNING_SECRET");
  }
  return resolved;
}

export function loadEmbedSigningSecret(environment: Environment): string {
  const dedicated = requireSecretInProduction(
    "EMBED_SIGNING_SECRET",
    environment.EMBED_SIGNING_SECRET,
    environment,
  );
  const resolved = dedicated || developmentFallback(environment, environment.EMBED_SIGNING_SECRET);
  if (!resolved) {
    throw new Error("Missing required environment variable: EMBED_SIGNING_SECRET");
  }
  return resolved;
}
