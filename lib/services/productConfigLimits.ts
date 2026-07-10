import type { ProductConfigField, ProductConfigSection } from "@/lib/types";

export const CONFIG_VALUE_LIMITS = {
  maxKnownKeys: 120,
  maxListItems: 50,
  maxListItemLength: 200,
  maxStringLength: 500,
  maxTextLength: 4000,
  maxSecretLength: 500,
  maxUrlLength: 300,
  maxColorLength: 32,
  maxSelectValueLength: 120,
  maxNumberMagnitude: 1_000_000_000_000,
  maxTotalSerializedBytes: 65_536,
} as const;

export class ProductConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductConfigValidationError";
  }
}

export function isSecretField(field: ProductConfigField): boolean {
  return field.secret || field.type === "secret";
}

function measureSerializedSize(values: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(values), "utf8");
}

function validateListValue(field: ProductConfigField, raw: unknown): string[] {
  const entries = Array.isArray(raw)
    ? raw.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : typeof raw === "string"
      ? raw
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
  if (entries.length > CONFIG_VALUE_LIMITS.maxListItems) {
    throw new ProductConfigValidationError(`"${field.label}" accepts at most ${CONFIG_VALUE_LIMITS.maxListItems} items.`);
  }
  for (const entry of entries) {
    if (entry.length > CONFIG_VALUE_LIMITS.maxListItemLength) {
      throw new ProductConfigValidationError(`Each "${field.label}" item must be at most ${CONFIG_VALUE_LIMITS.maxListItemLength} characters.`);
    }
  }
  return entries;
}

function validateScalarValue(field: ProductConfigField, raw: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ProductConfigValidationError(`"${field.label}" must be a valid number.`);
      }
      if (Math.abs(value) > CONFIG_VALUE_LIMITS.maxNumberMagnitude) {
        throw new ProductConfigValidationError(`"${field.label}" is out of range.`);
      }
      return value;
    }
    case "list":
      return validateListValue(field, raw);
    case "text": {
      const value = raw === null || raw === undefined ? "" : String(raw);
      if (value.length > CONFIG_VALUE_LIMITS.maxTextLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxTextLength} characters.`);
      }
      return value;
    }
    case "url": {
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value.length > CONFIG_VALUE_LIMITS.maxUrlLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxUrlLength} characters.`);
      }
      return value;
    }
    case "color": {
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value.length > CONFIG_VALUE_LIMITS.maxColorLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxColorLength} characters.`);
      }
      return value;
    }
    case "select": {
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value.length > CONFIG_VALUE_LIMITS.maxSelectValueLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxSelectValueLength} characters.`);
      }
      if (value.length > 0 && field.options.length > 0) {
        const allowed = new Set(field.options.map((option) => option.value));
        if (!allowed.has(value)) {
          throw new ProductConfigValidationError(`"${field.label}" has an invalid option.`);
        }
      }
      return value;
    }
    case "secret": {
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value.length > CONFIG_VALUE_LIMITS.maxSecretLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxSecretLength} characters.`);
      }
      return value;
    }
    default: {
      const value = raw === null || raw === undefined ? "" : String(raw);
      if (value.length > CONFIG_VALUE_LIMITS.maxStringLength) {
        throw new ProductConfigValidationError(`"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxStringLength} characters.`);
      }
      return value;
    }
  }
}

export function validateConfigValueInput(field: ProductConfigField, raw: unknown): unknown {
  if (isSecretField(field)) {
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > CONFIG_VALUE_LIMITS.maxSecretLength) {
        throw new ProductConfigValidationError(
          `"${field.label}" must be at most ${CONFIG_VALUE_LIMITS.maxSecretLength} characters.`,
        );
      }
      return trimmed;
    }
    if (raw && typeof raw === "object" && "set" in (raw as Record<string, unknown>)) {
      return raw;
    }
    throw new ProductConfigValidationError(`"${field.label}" must be provided as text.`);
  }
  return validateScalarValue(field, raw);
}

export function validateConfigValuesPayload(
  schema: ProductConfigSection[],
  values: Record<string, unknown> | undefined,
): void {
  if (!values) {
    return;
  }
  const fieldByKey = new Map(schema.flatMap((section) => section.fields).map((field) => [field.key, field]));
  const keys = Object.keys(values);
  if (keys.length > CONFIG_VALUE_LIMITS.maxKnownKeys) {
    throw new ProductConfigValidationError(
      `Configuration accepts at most ${CONFIG_VALUE_LIMITS.maxKnownKeys} fields per save.`,
    );
  }
  for (const key of keys) {
    if (!fieldByKey.has(key)) {
      throw new ProductConfigValidationError(`Unknown configuration field "${key}".`);
    }
    validateConfigValueInput(fieldByKey.get(key)!, values[key]);
  }
}

export function validateStoredConfigSize(values: Record<string, unknown>): void {
  if (measureSerializedSize(values) > CONFIG_VALUE_LIMITS.maxTotalSerializedBytes) {
    throw new ProductConfigValidationError("Configuration payload is too large.");
  }
}
