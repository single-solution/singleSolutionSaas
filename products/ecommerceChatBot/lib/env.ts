/**
 * Runtime configuration for the isolated chat product.
 */

interface ChatbotEnvironment {
  mongodbUri: string;
  mongodbDatabase: string;
  platformApiUrl: string;
  internalApiSecret: string;
  ssoSigningSecret: string;
  embedSigningSecret: string;
  productSlug: string;
  nodeEnv: "development" | "production" | "test";
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  cronSecret?: string;
  logLevel?: string;
  errorTrackingDsn?: string;
  demoDataRetentionDays?: number;
}

let cached: ChatbotEnvironment | null = null;

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\r/g, "");
  return trimmed === "" ? undefined : trimmed;
}

function required(name: string, value: string | undefined): string {
  const trimmed = trimEnvString(value);
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return trimmed;
}

function resolveSsoSigningSecret(nodeEnv: ChatbotEnvironment["nodeEnv"]): string {
  const dedicated = trimEnvString(process.env.SSO_SIGNING_SECRET);
  if (dedicated) {
    return dedicated;
  }
  if (nodeEnv === "production") {
    throw new Error("Missing required environment variable: SSO_SIGNING_SECRET");
  }
  const jwtSecret = trimEnvString(process.env.JWT_SECRET);
  if (jwtSecret) {
    return jwtSecret;
  }
  const internalSecret = trimEnvString(process.env.INTERNAL_API_SECRET);
  if (internalSecret) {
    return internalSecret;
  }
  throw new Error("Missing required environment variable: SSO_SIGNING_SECRET");
}

function resolveEmbedSigningSecret(nodeEnv: ChatbotEnvironment["nodeEnv"]): string {
  const dedicated = trimEnvString(process.env.EMBED_SIGNING_SECRET);
  if (dedicated) {
    return dedicated;
  }
  if (nodeEnv === "production") {
    throw new Error("Missing required environment variable: EMBED_SIGNING_SECRET");
  }
  const jwtSecret = trimEnvString(process.env.JWT_SECRET);
  if (jwtSecret) {
    return jwtSecret;
  }
  const internalSecret = trimEnvString(process.env.INTERNAL_API_SECRET);
  if (internalSecret) {
    return internalSecret;
  }
  throw new Error("Missing required environment variable: EMBED_SIGNING_SECRET");
}

export function loadEnvironment(): ChatbotEnvironment {
  if (cached) {
    return cached;
  }
  const nodeEnv =
    process.env.NODE_ENV === "production"
      ? "production"
      : process.env.NODE_ENV === "test"
        ? "test"
        : "development";
  cached = {
    mongodbUri: required("MONGODB_URI", process.env.MONGODB_URI),
    mongodbDatabase: process.env.MONGODB_CHATBOT_DB?.trim() || "chatbot",
    platformApiUrl: (process.env.PLATFORM_API_URL?.trim() || "http://localhost:3000").replace(/\/$/, ""),
    internalApiSecret: required("INTERNAL_API_SECRET", process.env.INTERNAL_API_SECRET),
    ssoSigningSecret: resolveSsoSigningSecret(nodeEnv),
    embedSigningSecret: resolveEmbedSigningSecret(nodeEnv),
    productSlug: process.env.PRODUCT_CATALOG_SLUG?.trim() || "ecommerce-chatbot",
    nodeEnv,
    upstashRedisRestUrl: trimEnvString(process.env.UPSTASH_REDIS_REST_URL),
    upstashRedisRestToken: trimEnvString(process.env.UPSTASH_REDIS_REST_TOKEN),
    cronSecret: trimEnvString(process.env.CRON_SECRET),
    logLevel: trimEnvString(process.env.LOG_LEVEL),
    errorTrackingDsn: trimEnvString(process.env.ERROR_TRACKING_DSN),
    demoDataRetentionDays: Number(process.env.DEMO_DATA_RETENTION_DAYS),
  };
  if (nodeEnv === "production") {
    if (!cached.upstashRedisRestUrl || !cached.upstashRedisRestToken) {
      throw new Error(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production.",
      );
    }
    if (!cached.cronSecret) {
      throw new Error("CRON_SECRET is required in production.");
    }
  }
  return cached;
}

export function isProductionEnvironment(): boolean {
  return loadEnvironment().nodeEnv === "production";
}
