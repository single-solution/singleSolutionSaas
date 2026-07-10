import { z } from "zod";

import { isValidObjectId } from "@/lib/db/connection";

const objectIdSchema = z.string().refine(isValidObjectId, { message: "Invalid id" });

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\r/g, "");
  return trimmed === "" ? undefined : trimmed;
}

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MONGODB_URI: z.preprocess(trimEnvString, z.string().min(1)),
  MONGODB_PLATFORM_DB: z.preprocess((value) => trimEnvString(value) ?? "platform", z.string().min(1)),
  JWT_SECRET: z.preprocess(trimEnvString, z.string().min(32)),
  INTERNAL_API_SECRET: z.preprocess(trimEnvString, z.string().min(16)),
  SSO_SIGNING_SECRET: z.preprocess(trimEnvString, z.string().min(16).optional()),
  PREVIEW_SIGNING_SECRET: z.preprocess(trimEnvString, z.string().min(16).optional()),
  EMBED_SIGNING_SECRET: z.preprocess(trimEnvString, z.string().min(16).optional()),
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess(trimEnvString, z.string().email().optional()),
  BOOTSTRAP_ADMIN_PASSWORD: z.preprocess(trimEnvString, z.string().min(8).optional()),
  APP_URL: z.preprocess(trimEnvString, z.string().url().optional()),
  UPSTASH_REDIS_REST_URL: z.preprocess(trimEnvString, z.string().url().optional()),
  UPSTASH_REDIS_REST_TOKEN: z.preprocess(trimEnvString, z.string().min(1).optional()),
  SMTP_HOST: z.preprocess(trimEnvString, z.string().min(1).optional()),
  SMTP_PORT: z.preprocess((value) => trimEnvString(value), z.coerce.number().int().positive().max(65535).optional()),
  SMTP_SECURE: z.preprocess((value) => trimEnvString(value), z.enum(["true", "false"]).optional()),
  SMTP_USER: z.preprocess(trimEnvString, z.string().min(1).optional()),
  SMTP_PASSWORD: z.preprocess(trimEnvString, z.string().min(1).optional()),
  EMAIL_FROM: z.preprocess(trimEnvString, z.string().min(1).optional()),
  EMAIL_REPLY_TO: z.preprocess(trimEnvString, z.string().email().optional()),
  CONFIG_ENCRYPTION_KEYS: z.preprocess(trimEnvString, z.string().min(2).optional()),
  CONFIG_ENCRYPTION_ACTIVE_KEY_ID: z.preprocess(trimEnvString, z.string().min(1).max(32).optional()),
  CRON_SECRET: z.preprocess(trimEnvString, z.string().min(16).optional()),
  LOG_LEVEL: z.preprocess(trimEnvString, z.enum(["fatal", "error", "warn", "info", "debug"]).optional()),
  ERROR_TRACKING_DSN: z.preprocess(trimEnvString, z.string().url().optional()),
});

export type Environment = z.infer<typeof environmentSchema>;

const productionEnvironmentSchema = environmentSchema.superRefine((environment, context) => {
  if (environment.NODE_ENV !== "production") {
    return;
  }
  if (!environment.APP_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_URL"],
      message: "APP_URL is required in production",
    });
  }
  if (!environment.UPSTASH_REDIS_REST_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["UPSTASH_REDIS_REST_URL"],
      message: "UPSTASH_REDIS_REST_URL is required in production",
    });
  }
  if (!environment.UPSTASH_REDIS_REST_TOKEN) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["UPSTASH_REDIS_REST_TOKEN"],
      message: "UPSTASH_REDIS_REST_TOKEN is required in production",
    });
  }
  if (!environment.CRON_SECRET) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CRON_SECRET"],
      message: "CRON_SECRET is required in production",
    });
  }
});

export function loadEnvironment(): Environment {
  const parsed = productionEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }
  return parsed.data;
}

export const idParamSchema = z.object({ id: objectIdSchema });

export const merchantIdParamSchema = z.object({ merchantId: objectIdSchema });

export const siteIdParamSchema = z.object({ siteId: objectIdSchema });

export const loginBodySchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
  })
  .strict();

export const updateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined, { message: "At least one field is required" });

export const createMerchantBodySchema = z
  .object({
    merchantName: z.string().trim().min(1).max(120),
    ownerName: z.string().trim().min(1).max(120),
    ownerEmail: z.string().trim().email().max(200),
  })
  .strict();

export const acceptInvitationBodySchema = z
  .object({
    token: z.string().min(20).max(200),
    password: z.string().min(8).max(128),
  })
  .strict();

export const updateProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional(),
  })
  .strict();

export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(8).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export const logoutSessionBodySchema = z
  .object({
    scope: z.enum(["current", "all"]).default("current"),
  })
  .strict();

export const exchangeSsoBodySchema = z
  .object({
    code: z.string().min(20).max(200),
    productSlug: z.string().trim().min(2).max(80),
  })
  .strict();

export const verifyPlatformSessionBodySchema = z
  .object({
    userId: z.string().min(1).max(64),
    sessionVersion: z.number().int().min(0),
  })
  .strict();

const domainPattern = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const primaryDomainSchema = z
  .string()
  .trim()
  .max(200)
  .regex(domainPattern, "Enter a valid domain, e.g. shop.example.com")
  .or(z.literal(""));

export const createSiteBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    primaryDomain: primaryDomainSchema.optional().default(""),
  })
  .strict();

export const updateSiteBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    primaryDomain: primaryDomainSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.primaryDomain !== undefined, {
    message: "At least one field is required",
  });

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be lowercase kebab-case");

const scopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:[:._-][a-z0-9]+)*$/, "Invalid scope");

const planQuotaSchema = z
  .object({
    metric: z.string().trim().min(1).max(60),
    limit: z.number().int().min(0),
    unit: z.string().trim().max(30).optional(),
  })
  .strict();

const productPlanSchema = z
  .object({
    code: slugSchema,
    name: z.string().trim().min(1).max(80),
    priceMonthly: z.number().min(0).default(0),
    currency: z.string().trim().length(3).default("USD"),
    scopes: z.array(scopeSchema).max(50).default([]),
    quotas: z.array(planQuotaSchema).max(30).default([]),
  })
  .strict();

const configFieldSchema = z
  .object({
    key: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["string", "text", "number", "boolean", "select", "color", "url", "secret", "list"]).default("string"),
    default: z.unknown().optional(),
    help: z.string().trim().max(300).optional().default(""),
    options: z
      .array(z.object({ value: z.string().trim().max(120), label: z.string().trim().max(120) }).strict())
      .max(50)
      .optional()
      .default([]),
    required: z.boolean().optional().default(false),
    secret: z.boolean().optional().default(false),
    lockable: z.boolean().optional().default(true),
    group: z.string().trim().max(60).optional().default(""),
  })
  .strict();

const configSectionSchema = z
  .object({
    key: z.string().trim().min(1).max(60),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).optional().default(""),
    kind: z.enum(["settings", "connection", "integration"]).optional().default("settings"),
    fields: z.array(configFieldSchema).max(60).default([]),
  })
  .strict();

export const productConfigSchemaSchema = z.array(configSectionSchema).max(20);

const testActionSchema = z
  .object({
    key: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).optional().default(""),
    inputLabel: z.string().trim().max(120).optional().default("Sample input"),
    inputPlaceholder: z.string().trim().max(200).optional().default(""),
  })
  .strict();

export const productTestActionsSchema = z.array(testActionSchema).max(20);

export const productSlugParamSchema = z.object({ productSlug: slugSchema });

export const createProductBodySchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    baseUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
    availableScopes: z.array(scopeSchema).max(50).default([]),
    plans: z.array(productPlanSchema).max(20).default([]),
    configSchema: productConfigSchemaSchema.optional().default([]),
    testActions: productTestActionsSchema.optional().default([]),
  })
  .strict();

export const updateProductBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    baseUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
    status: z.enum(["active", "inactive"]).optional(),
    availableScopes: z.array(scopeSchema).max(50).optional(),
    plans: z.array(productPlanSchema).max(20).optional(),
    configSchema: productConfigSchemaSchema.optional(),
    testActions: productTestActionsSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field is required" });

export const updateSubscriptionBodySchema = z
  .object({
    planCode: slugSchema.nullable().optional(),
    status: z.enum(["active", "suspended"]).optional(),
    action: z.enum(["restore", "unassign"]).optional(),
    scopeOverrides: z.array(scopeSchema).max(50).nullable().optional(),
    quotaOverrides: z.array(planQuotaSchema).max(30).nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.planCode !== undefined ||
      body.status !== undefined ||
      body.action !== undefined ||
      body.scopeOverrides !== undefined ||
      body.quotaOverrides !== undefined,
    { message: "At least one field is required" },
  );

export const createProductTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    allowedDomains: z
      .array(z.string().trim().regex(domainPattern, "Enter a valid domain, e.g. example.com or *.example.com"))
      .max(20)
      .optional()
      .default([]),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

export const rotateProductTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    revokePrevious: z.boolean().optional().default(true),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

export const inviteMerchantMemberBodySchema = z
  .object({
    email: z.string().trim().email().max(200),
    name: z.string().trim().min(1).max(120),
    role: z.enum(["admin", "member"]),
  })
  .strict();

export const updateMerchantMemberBodySchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]),
  })
  .strict();

export const verifyProductTokenBodySchema = z
  .object({
    token: z.string().min(20).max(200),
  })
  .strict();

export const recordProductUsageBodySchema = z
  .object({
    token: z.string().min(20).max(200),
    metric: z.string().trim().min(1).max(60),
    quantity: z.number().int().min(1).max(1_000_000).default(1),
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .strict();

const configFieldKeySchema = z.string().trim().min(1).max(60);

const configValuesBodySchema = z
  .record(configFieldKeySchema, z.unknown())
  .superRefine((values, context) => {
    const keys = Object.keys(values);
    if (keys.length > 120) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Configuration accepts at most 120 fields per save.",
      });
    }
  });

export const updateProductConfigBodySchema = z
  .object({
    values: configValuesBodySchema.optional(),
    lockedFields: z.array(configFieldKeySchema).max(120).optional(),
    clearKeys: z.array(configFieldKeySchema).max(120).optional(),
  })
  .strict()
  .refine(
    (body) => body.values !== undefined || body.lockedFields !== undefined || body.clearKeys !== undefined,
    { message: "At least one field is required" },
  );

export const updateProductDefaultsBodySchema = z
  .object({
    values: configValuesBodySchema.optional(),
    lockedFields: z.array(configFieldKeySchema).max(120).optional(),
  })
  .strict()
  .refine((body) => body.values !== undefined || body.lockedFields !== undefined, {
    message: "At least one field is required",
  });

export const runProductTestBodySchema = z
  .object({
    action: z.string().trim().min(1).max(60),
    input: z.string().max(4000).optional().default(""),
  })
  .strict();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
