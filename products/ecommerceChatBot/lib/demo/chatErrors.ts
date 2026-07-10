import { ChatRequestError } from "@/lib/chat/transport";

export type DemoWidgetIssue =
  | "loading"
  | "ready"
  | "expired"
  | "rate_limited"
  | "unavailable"
  | "unsupported_origin"
  | "quota_exceeded"
  | "disabled";

export function describeDemoWidgetIssue(issue: DemoWidgetIssue): {
  title: string;
  detail: string;
} {
  switch (issue) {
    case "loading":
      return {
        title: "Starting live demo",
        detail: "Connecting to the sandbox chat assistant…",
      };
    case "expired":
      return {
        title: "Demo link expired",
        detail:
          "This demo token is no longer valid. Ask your administrator to refresh the public demo configuration.",
      };
    case "rate_limited":
      return {
        title: "Demo is busy",
        detail:
          "Too many messages were sent in a short time. Wait a minute, then try again.",
      };
    case "unavailable":
      return {
        title: "Demo temporarily unavailable",
        detail:
          "The chat service could not be reached. Check your connection or try again shortly.",
      };
    case "unsupported_origin":
      return {
        title: "Unsupported website",
        detail:
          "This demo token is not allowed to run from this address. Open it from the official demo link.",
      };
    case "quota_exceeded":
      return {
        title: "Demo limit reached",
        detail:
          "The sandbox has reached its monthly message allowance. Try again later or contact support.",
      };
    case "disabled":
      return {
        title: "Chat disabled",
        detail: "The demo merchant has turned off chat for this sandbox.",
      };
    case "ready":
      return {
        title: "Live demo ready",
        detail: "Use the chat bubble to try the assistant.",
      };
  }
}

export function issueFromChatError(error: unknown): DemoWidgetIssue {
  if (!(error instanceof ChatRequestError)) {
    return "unavailable";
  }
  if (error.code === "origin_not_allowed") {
    return "unsupported_origin";
  }
  if (error.code === "demo_expired") {
    return "expired";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (error.code === "unavailable") {
    return "unavailable";
  }
  if (error.code === "quota_exceeded") {
    return "quota_exceeded";
  }
  if (
    error.message.toLowerCase().includes("invalid") ||
    error.message.toLowerCase().includes("inactive")
  ) {
    return "expired";
  }
  if (
    error.message.toLowerCase().includes("slow down") ||
    error.message.toLowerCase().includes("too many")
  ) {
    return "rate_limited";
  }
  return "unavailable";
}
