/** Defer a state update out of the current render/commit phase. */
export function scheduleStateUpdate(fn: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(fn);
    return;
  }
  setTimeout(fn, 0);
}
