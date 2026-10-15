/**
 * Structured logging. The kit never writes to the console itself: callers inject a logger, or use `createLogger`
 * (JSON lines to standard output, or to a `write` sink). Each product passes `createLogger()` to the kit in its
 * `app/api/[...path]/route.js`, so a failed route (500), a misconfiguration (503) and the kit's warnings reach the host's
 * logs.
 *
 * Redaction, applied to every field, recursively (the Portal's rules, plus the names of stored connection secrets):
 * - members whose name, in lower case with `_` and `-` removed, contains `secret`, `token`, `password`, `passwd`,
 *   `passphrase`, `authorization`, `cookie`, `apikey`, `accesskey`, `privatekey`, `privatejwk`, `signingkey`,
 *   `credential`, `connectionstring`, `descriptor`, `kek`, `pepper` or `sealed`, that end in `uri`, or that equal `d`
 *   (a JWK's private member);
 * - in every text, error messages too: signed tokens (compact JWS, `eyJ….….…`) and the user part of addresses
 *   (`mongodb+srv://user:pass@host` → `mongodb+srv://[redacted]@host`);
 * - errors become `{ name, message, code? }` (no stacks), dates ISO texts.
 * @module
 */
import { isObject } from './util.js';

/** @typedef {'debug' | 'info' | 'warn' | 'error' | 'silent'} LogLevel */
/**
 * @typedef {object} Logger
 * @property {(message: string, fields?: Record<string, unknown>) => void} debug
 * @property {(message: string, fields?: Record<string, unknown>) => void} info
 * @property {(message: string, fields?: Record<string, unknown>) => void} warn
 * @property {(message: string, fields?: Record<string, unknown>) => void} error
 * @property {(fields: Record<string, unknown>) => Logger} child
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

const SENSITIVE_KEY =
	/secret|token|password|passwd|passphrase|authorization|cookie|apikey|accesskey|privatekey|privatejwk|signingkey|credential|connectionstring|descriptor|kek|pepper|sealed/;
const SIGNED_TOKEN = /eyJ[\w-]*\.[\w-]+\.[\w-]+/g;
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/gi;

/**
 * @param {string} key
 * @returns {boolean}
 */
const isSensitiveKey = (key) => {
	const k = key.toLowerCase().replace(/[_-]/g, '');
	return k === 'd' || k.endsWith('uri') || SENSITIVE_KEY.test(k);
};

/**
 * @param {string} text
 * @returns {string}
 */
const redactText = (text) => text.replace(SIGNED_TOKEN, '[redacted]').replace(USERINFO, '$1[redacted]@');

/**
 * Deep-copy `value` with credential-like members and texts replaced by `[redacted]`.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export const redact = (value, depth = 0) => {
	if (depth > 8) return '[depth]';
	if (typeof value === 'string') return redactText(value);
	if (value instanceof Error) {
		const code = /** @type {{ code?: unknown }} */ (value).code;
		return { name: value.name, message: redactText(value.message), ...(code === undefined ? {} : { code }) };
	}
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (isObject(value)) {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = isSensitiveKey(key) ? '[redacted]' : redact(item, depth + 1);
		return out;
	}
	return value;
};

/** @type {Logger} */
export const noopLogger = Object.freeze({
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
});

/**
 * JSON-lines logger writing to an injected sink.
 * @param {{ level?: LogLevel | string, write?: (line: string) => void, now?: () => number, fields?: Record<string, unknown> }} [options]
 * @returns {Logger}
 */
export const createLogger = ({ level = 'info', write, now = Date.now, fields = {} } = {}) => {
	const threshold = LEVELS[/** @type {LogLevel} */ (level)] ?? LEVELS.info;
	const sink = write ?? ((line) => process.stdout.write(`${line}\n`));
	/**
	 * @param {Exclude<LogLevel, 'silent'>} lvl
	 * @returns {(message: string, extra?: Record<string, unknown>) => void}
	 */
	const at = (lvl) => (message, extra) => {
		if (LEVELS[lvl] < threshold) return;
		const record = { level: lvl, time: new Date(now()).toISOString(), msg: message, ...fields, ...(extra ?? {}) };
		sink(JSON.stringify(redact(record)));
	};
	return Object.freeze({
		debug: at('debug'),
		info: at('info'),
		warn: at('warn'),
		error: at('error'),
		child: (more) => createLogger({ level, write: sink, now, fields: { ...fields, ...more } }),
	});
};
