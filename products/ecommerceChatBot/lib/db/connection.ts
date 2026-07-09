import mongoose from "mongoose";

import { loadEnvironment } from "@/lib/env";

let connected = false;

/**
 * Connect to the product's own database. Uses the same Atlas cluster as the
 * platform but a separate database name so the chat data stays isolated.
 */
export async function connectDb(): Promise<typeof mongoose> {
  if (connected && mongoose.connection.readyState === 1) {
    return mongoose;
  }
  const { mongodbUri, mongodbDatabase } = loadEnvironment();
  const base = mongodbUri.replace(/\/$/, "");
  await mongoose.connect(`${base}/${mongodbDatabase}`, {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
  });
  connected = true;
  return mongoose;
}

export { Types } from "mongoose";
