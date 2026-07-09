/**
 * Polling transport for the chat UI. Closed = zero timers; open = visibility-
 * aware intervals with idle backoff.
 */

export interface CreateChatTransportOptions {
  pollIntervalMsFocused: number;
  pollIntervalMsBlurred: number;
  onTick: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface ChatTransport {
  start(): void;
  stop(): void;
  touch(): void;
  pollNow(): void;
  isRunning(): boolean;
}

const IDLE_WARN_MS = 5 * 60_000;
const IDLE_MAX_MS = 15 * 60_000;

export function createChatTransport(options: CreateChatTransportOptions): ChatTransport {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivityAt = 0;

  function getInterval(): number {
    const base = typeof document !== "undefined" && document.hidden ? options.pollIntervalMsBlurred : options.pollIntervalMsFocused;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs >= IDLE_MAX_MS) return Math.max(base, 60_000);
    if (idleMs >= IDLE_WARN_MS) return Math.max(base, 20_000);
    return base;
  }

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await options.onTick();
    } catch (error) {
      options.onError?.(error);
    } finally {
      if (running) {
        timer = setTimeout(() => void tick(), getInterval());
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastActivityAt = Date.now();
      void tick();
    },
    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    touch() {
      lastActivityAt = Date.now();
    },
    pollNow() {
      if (!running) return;
      lastActivityAt = Date.now();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      void tick();
    },
    isRunning() {
      return running;
    },
  };
}
