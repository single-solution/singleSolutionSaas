export const COMMAND_SEARCH_OPEN_EVENT = "portal:open-command-search";

/** Request that the mounted portal command search opens. */
export function openCommandSearch(): void {
  window.dispatchEvent(new CustomEvent(COMMAND_SEARCH_OPEN_EVENT));
}
