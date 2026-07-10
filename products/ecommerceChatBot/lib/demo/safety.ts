/**
 * Guards that keep the public demo sandbox read-only and rate-limited.
 */

import { loadPublicDemoConfig } from "./config";

const DEMO_IP_MAX_PER_MINUTE = 45;
const DEMO_VISITOR_MAX_PER_MINUTE = 20;

export function isPublicDemoToken(token: string | null | undefined): boolean {
  if (!token) {
    return false;
  }
  const configured = loadPublicDemoConfig().productToken;
  return Boolean(configured && token.trim() === configured);
}

export function demoIpRateLimitMax(): number {
  return DEMO_IP_MAX_PER_MINUTE;
}

export function demoMessageRateLimitMax(): number {
  return DEMO_VISITOR_MAX_PER_MINUTE;
}

export function demoForbiddenMessage(): string {
  return "Demo administration is not available in the public sandbox.";
}
