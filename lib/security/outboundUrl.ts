import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;

export class OutboundUrlError extends Error {
  constructor(
    message: string,
    readonly field = "url",
  ) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [first, second] = parts;
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 0) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80:")) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address);
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export interface ValidateOutboundUrlOptions {
  isProduction: boolean;
  allowLocalhost?: boolean;
}

export async function validateOutboundUrl(
  rawUrl: string,
  options: ValidateOutboundUrlOptions,
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new OutboundUrlError("URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OutboundUrlError("Enter a valid absolute URL.");
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !options.isProduction)) {
    throw new OutboundUrlError(
      options.isProduction
        ? "Only HTTPS URLs are allowed in production."
        : "URL must use HTTP or HTTPS.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new OutboundUrlError("URLs with embedded credentials are not allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isLocalDevelopmentHost(hostname)) {
    if (options.isProduction) {
      throw new OutboundUrlError("Localhost URLs are not allowed in production.");
    }
    if (!options.allowLocalhost) {
      throw new OutboundUrlError("Localhost URLs are not allowed for this request.");
    }
    return parsed;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new OutboundUrlError("Could not resolve the host.");
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new OutboundUrlError("Private or loopback addresses are not allowed.");
    }
  }

  return parsed;
}

export interface SafeFetchOptions extends ValidateOutboundUrlOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  response: Response;
  bodyText: string;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const parsed = await validateOutboundUrl(rawUrl, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent);

  try {
    const response = await fetch(parsed.toString(), {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new OutboundUrlError("Redirects are not allowed for outbound requests.");
    }

    const reader = response.body?.getReader();
    let bodyText = "";
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          throw new OutboundUrlError("Response body exceeds the allowed size.");
        }
        chunks.push(value);
      }
      bodyText = Buffer.concat(chunks).toString("utf8");
    }

    return { response, bodyText };
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new OutboundUrlError("Outbound request timed out.");
    }
    throw new OutboundUrlError("Outbound request failed.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
