/**
 * Structured logging. The kit never writes to the console itself: callers inject a logger, or use `createLogger`
 * with a `write` sink. Fields whose names look like credentials are redacted before they reach the sink.
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

/** Field names that are always redacted (case-insensitive). */
export const REDACTED_FIELDS = Object.freeze([
	'authorization',
	'cookie',
	'password',
	'secret',
	'secretaccesskey',
	'accesskeyid',
	'sessiontoken',
	'apikey',
	'token',
	'uri',
	'url_with_credentials',
	'connectionstring',
	'signingkey',
	'privatejwk',
	'd',
	'descriptor',
	'credentials',
]);
const REDACT = new Set(REDACTED_FIELDS);

/**
 * Deep-copy `value`, replacing credential-like fields with `[redacted]` and errors with `{ name, code, message }`.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export const redact = (value, depth = 0) => {
	if (depth > 6) return '[depth]';
	if (value instanceof Error) {
		return { name: value.name, message: value.message, ...('code' in value ? { code: /** @type {any} */ (value).code } : {}) };
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (isObject(value)) {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = REDACT.has(key.toLowerCase()) ? '[redacted]' : redact(item, depth + 1);
		}
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
