/**
 * Runtime configuration for the isolated chat product.
 *
 * The product keeps its own database (separate DB, same Atlas cluster as the
 * platform) and talks to the platform's internal endpoints server-to-server to
 * verify the merchant's product access token and report message usage for
 * billing. All secrets stay on the server — the widget never sees them.
 */

interface ChatbotEnvironment {
  mongodbUri: string;
  mongodbDatabase: string;
  platformApiUrl: string;
  internalApiSecret: string;
}

let cached: ChatbotEnvironment | null = null;

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return trimmed;
}

export function loadEnvironment(): ChatbotEnvironment {
  if (cached) {
    return cached;
  }
  cached = {
    mongodbUri: required("MONGODB_URI", process.env.MONGODB_URI),
    mongodbDatabase: process.env.MONGODB_CHATBOT_DB?.trim() || "chatbot",
    platformApiUrl: (process.env.PLATFORM_API_URL?.trim() || "http://localhost:3000").replace(/\/$/, ""),
    internalApiSecret: required("INTERNAL_API_SECRET", process.env.INTERNAL_API_SECRET),
  };
  return cached;
}
