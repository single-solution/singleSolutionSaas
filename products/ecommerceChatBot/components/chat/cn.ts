export function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Customer-facing label for automated replies. */
export const CHAT_SUPPORT_DISPLAY_NAME = "Chat Support";
