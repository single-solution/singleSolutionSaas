import { loadEnvironment } from "@/lib/env";
import { connectDb } from "@/lib/db/connection";
import { bootstrapPlatformAdmin } from "@/lib/services/platform.service";

let readyPromise: Promise<void> | null = null;

export function ensurePlatformReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const environment = loadEnvironment();
      await connectDb(environment.MONGODB_URI, environment.MONGODB_PLATFORM_DB);
      if (environment.BOOTSTRAP_ADMIN_EMAIL && environment.BOOTSTRAP_ADMIN_PASSWORD) {
        await bootstrapPlatformAdmin(environment.BOOTSTRAP_ADMIN_EMAIL, environment.BOOTSTRAP_ADMIN_PASSWORD);
      }
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}
