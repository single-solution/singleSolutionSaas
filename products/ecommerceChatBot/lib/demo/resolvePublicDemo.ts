import { verifyProductToken } from "@/lib/platform/client";

import { loadPublicDemoConfig } from "./config";

export type PublicDemoRuntimeStatus =
  "ready" | "unconfigured" | "invalid" | "unavailable";

export interface PublicDemoResolution {
  token: string | null;
  status: PublicDemoRuntimeStatus;
}

export async function resolvePublicDemo(
  tokenOverride?: string | null,
): Promise<PublicDemoResolution> {
  const configured = loadPublicDemoConfig();
  const token = tokenOverride?.trim() || configured.productToken;
  if (!token) {
    return { token: null, status: "unconfigured" };
  }

  try {
    const entitlement = await verifyProductToken(token);
    if (!entitlement) {
      return { token, status: "invalid" };
    }
    return { token, status: "ready" };
  } catch {
    return { token, status: "unavailable" };
  }
}
