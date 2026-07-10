const domainPattern =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  try {
    return new URL(
      normalized.includes("://") ? normalized : `https://${normalized}`,
    ).hostname;
  } catch {
    return normalized.replace(/^https?:\/\//, "").split("/")[0];
  }
}

export function isValidHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  if (!hostname) {
    return false;
  }
  return domainPattern.test(hostname);
}

export function domainMatchesAllowlist(
  hostname: string,
  allowedDomains: string[],
): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  return allowedDomains.some((allowed) => {
    const pattern = normalizeHostname(allowed);
    if (!pattern) {
      return false;
    }
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return normalized === suffix || normalized.endsWith(`.${suffix}`);
    }
    return normalized === pattern;
  });
}
