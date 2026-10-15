/**
 * Structured logging: the one logger of `@ss/net` (JSON lines, credential redaction by pattern; see its README). The kit
 * never writes to the console itself: callers inject a logger, or use `createLogger`. Each product passes
 * `createLogger()` to the kit in its `app/api/[...path]/route.js`, so a failed route (500), a misconfiguration (503) and
 * the kit's warnings reach the host's logs.
 * @module
 */
export { createLogger, noopLogger, redact } from '@ss/net';

/** @typedef {import('@ss/net').Logger} Logger */
