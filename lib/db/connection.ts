import mongoose from "mongoose";

let connected = false;

export async function connectDb(clusterUri: string, databaseName: string): Promise<typeof mongoose> {
  if (connected && mongoose.connection.readyState === 1) {
    return mongoose;
  }

  const base = clusterUri.replace(/\/$/, "");
  const uri = `${base}/${databaseName}`;
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
  });
  connected = true;
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (!connected) {
    return;
  }
  await mongoose.disconnect();
  connected = false;
}

export function isValidObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
}

export { Types } from "mongoose";
