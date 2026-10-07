/**
 * Structured JSON logger with redaction. Nothing in the Portal writes to the console: a logger is injected
 * everywhere, and `createLogger` writes JSON lines to an injected sink (stdout by default).
 *
 * Redaction (applied to every field, recursively):
 * - keys whose normalised name (lower case, `_`/`-` removed) contains `secret`, `token`, `password`, `passwd`,
 *   `passphrase`, `authorization`, `cookie`, `apikey`, `privatekey`, `privatejwk`, `signingkey`, `credential`,
 *   `connectionstring`, `kek`, `pepper`, `sealed`, or that end in `uri`, or equal `d` (JWK private member);
 * - string values that look like signed tokens (compact JWS: `eyJ….….…` — browser and server tokens, launches), or URLs
 *   with userinfo (`mongodb+srv://user:pass@host` → `mongodb+srv://[redacted]@host`);
 * - errors become `{ name, message, code? }` (no stacks with request data).
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
	/secret|token|password|passwd|passphrase|authorization|cookie|apikey|privatekey|privatejwk|signingkey|credential|connectionstring|kek|pepper|sealed/;
const SECRET_VALUE = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;

/**
 * @param {string} key
 * @returns {boolean}
 */
export const isSensitiveKey = (key) => {
	const k = key.toLowerCase().replace(/[_-]/g, '');
	return k === 'd' || k.endsWith('uri') || SENSITIVE_KEY.test(k);
};

/**
 * Deep-copy `value` with sensitive members replaced by `[redacted]`.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export const redact = (value, depth = 0) => {
	if (depth > 8) return '[depth]';
	if (typeof value === 'string') {
		if (SECRET_VALUE.test(value)) return '[redacted]';
		return USERINFO.test(value) ? value.replace(USERINFO, '$1[redacted]@') : value;
	}
	if (value instanceof Error) {
		const code = /** @type {{ code?: unknown }} */ (value).code;
		return { name: value.name, message: value.message, ...(code === undefined ? {} : { code }) };
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
 * JSON-lines logger.
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
