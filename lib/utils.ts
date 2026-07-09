import type { Environment } from "@/lib/env";

export function getPagination(page: number, pageSize: number) {
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(Math.max(1, pageSize), 100);
  const offset = (safePage - 1) * safePageSize;
  return { page: safePage, pageSize: safePageSize, offset, limit: safePageSize };
}

export function isProduction(environment: Environment): boolean {
  return environment.NODE_ENV === "production";
}
