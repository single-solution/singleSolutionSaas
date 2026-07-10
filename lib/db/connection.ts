import mongoose from "mongoose";

const CONNECT_TIMEOUT_MS = 8_000;

export type DbConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface DbConnectionState {
  status: DbConnectionStatus;
  lastError?: string;
  lastConnectedAt?: number;
}

declare global {
  var __platformMongoosePromise: Promise<typeof mongoose> | undefined;
  var __platformMongooseState: DbConnectionState | undefined;
}

function getConnectionState(): DbConnectionState {
  return (
    globalThis.__platformMongooseState ?? {
      status: "disconnected",
    }
  );
}

function setConnectionState(state: DbConnectionState): void {
  globalThis.__platformMongooseState = state;
}

function resetConnectionPromise(): void {
  globalThis.__platformMongoosePromise = undefined;
}

function attachConnectionListeners(): void {
  const connection = mongoose.connection;
  connection.on("disconnected", () => {
    setConnectionState({ status: "disconnected" });
    resetConnectionPromise();
  });
  connection.on("error", (error) => {
    setConnectionState({
      status: "error",
      lastError: error.message,
    });
    resetConnectionPromise();
  });
}

export function getDbConnectionState(): DbConnectionState {
  const state = getConnectionState();
  if (mongoose.connection.readyState === 1 && state.status !== "connected") {
    return { ...state, status: "connected" };
  }
  return state;
}

export async function pingDb(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }
  try {
    await mongoose.connection.db?.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function connectDb(clusterUri: string, databaseName: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    setConnectionState({
      status: "connected",
      lastConnectedAt: Date.now(),
    });
    return mongoose;
  }

  if (!globalThis.__platformMongoosePromise) {
    setConnectionState({ status: "connecting" });
    const base = clusterUri.replace(/\/$/, "");
    const uri = `${base}/${databaseName}`;
    globalThis.__platformMongoosePromise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        connectTimeoutMS: CONNECT_TIMEOUT_MS,
      })
      .then((connection) => {
        attachConnectionListeners();
        setConnectionState({
          status: "connected",
          lastConnectedAt: Date.now(),
          lastError: undefined,
        });
        return connection;
      })
      .catch((error) => {
        setConnectionState({
          status: "error",
          lastError: error instanceof Error ? error.message : "Database connection failed",
        });
        resetConnectionPromise();
        throw error;
      });
  }

  return globalThis.__platformMongoosePromise;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    setConnectionState({ status: "disconnected" });
    resetConnectionPromise();
    return;
  }
  await mongoose.disconnect();
  setConnectionState({ status: "disconnected" });
  resetConnectionPromise();
}

export function isValidObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
}

export { Types } from "mongoose";
