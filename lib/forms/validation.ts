const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Enter your email address.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "Enter a valid email address.";
  }
  if (trimmed.length > 320) {
    return "Email must be 320 characters or fewer.";
  }
  return undefined;
}

export function validatePassword(value: string): string | undefined {
  if (!value) {
    return "Enter your password.";
  }
  if (value.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (value.length > 128) {
    return "Password must be 128 characters or fewer.";
  }
  return undefined;
}

export function validateResourceName(value: string, resourceLabel: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return `Enter a ${resourceLabel.toLowerCase()}.`;
  }
  if (trimmed.length > 120) {
    return `${resourceLabel} must be 120 characters or fewer.`;
  }
  return undefined;
}

export function validateSlug(value: string, options?: { required?: boolean }): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return options?.required ? "Enter a slug." : undefined;
  }
  if (trimmed.length < 2) {
    return "Slug must be at least 2 characters.";
  }
  if (trimmed.length > 80) {
    return "Slug must be 80 characters or fewer.";
  }
  if (!SLUG_PATTERN.test(trimmed)) {
    return "Use lowercase letters, numbers, and hyphens only.";
  }
  return undefined;
}

export function validateApiKeyName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Enter a key name.";
  }
  if (trimmed.length > 80) {
    return "Key name must be 80 characters or fewer.";
  }
  return undefined;
}
