import { getRequestAuth } from "@/lib/api/auth";

export async function getServerSession() {
  return getRequestAuth();
}
