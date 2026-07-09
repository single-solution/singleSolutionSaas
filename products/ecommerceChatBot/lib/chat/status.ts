import type { ChatStatus } from "./types";

function nextStatusAfterCustomerMessage(current: ChatStatus): ChatStatus | null {
  return current === "resolved" ? "open" : null;
}

function nextStatusAfterTeamMessage(current: ChatStatus): ChatStatus | null {
  return current === "open" ? "awaiting-customer" : null;
}

/** Status patch for `$set` after a message is posted (empty when unchanged). */
export function statusPatchAfterMessage(current: ChatStatus, author: "customer" | "team" | "assistant"): { status?: ChatStatus } {
  const next = author === "customer" ? nextStatusAfterCustomerMessage(current) : nextStatusAfterTeamMessage(current);
  return next ? { status: next } : {};
}
