/**
 * Internal helpers shared by the SDK modules (not part of the public API). Browser globals are always read through
 * `globalThis` so every module also loads in non-browser runtimes (SSR, tests) and every side effect can be injected.
 * @module
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * @callback RandomBytes
 * @param {number} length
 * @returns {Uint8Array}
 */

/** @type {RandomBytes} */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * A platform-style opaque id: `<prefix>_` + 128 random bits as 26 lowercase Crockford base32 characters
 * (the same shape as `@ss/contracts` `createId`, duplicated here to keep the browser bundle free of Ajv).
 * @param {string} prefix
 * @param {RandomBytes} [randomBytes]
 * @returns {string}
 */
export const createId = (prefix, randomBytes = defaultRandomBytes) => {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of randomBytes(16)) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	return `${prefix}_${out}${ALPHABET[(buffer << (5 - bits)) & 31]}`;
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isPlainObject = (value) => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/**
 * @typedef {object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/**
 * @typedef {object} SafeStorage
 * @property {(key: string) => unknown} read parsed JSON or `undefined` (missing, corrupt, or storage unavailable)
 * @property {(key: string, value: unknown) => boolean} write false when storage is unavailable or full
 * @property {(key: string) => void} remove
 */

/**
 * The page's localStorage, or `undefined` when it is unavailable (privacy mode, sandboxed iframe, SSR).
 * @returns {StorageLike | undefined}
 */
export const defaultStorage = () => {
	try {
		return /** @type {StorageLike | undefined} */ (globalThis.localStorage ?? undefined);
	} catch {
		return undefined;
	}
};

/**
 * Wrap a Storage so that no call ever throws and values are JSON.
 * @param {StorageLike | undefined | null} storage
 * @returns {SafeStorage}
 */
export const safeStorage = (storage) => ({
	read: (key) => {
		try {
			const raw = storage?.getItem(key);
			return raw === null || raw === undefined ? undefined : JSON.parse(raw);
		} catch {
			return undefined;
		}
	},
	write: (key, value) => {
		try {
			if (!storage) return false;
			storage.setItem(key, JSON.stringify(value));
			return true;
		} catch {
			return false;
		}
	},
	remove: (key) => {
		try {
			storage?.removeItem(key);
		} catch {
			/* unavailable */
		}
	},
});

const DURATION =
	/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const DURATION_UNITS_MS = [365 * 864e5, 30 * 864e5, 7 * 864e5, 864e5, 36e5, 6e4, 1e3];

/**
 * ISO-8601 duration → milliseconds (years = 365 days, months = 30 days). `undefined` when invalid or empty.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export const parseDuration = (value) => {
	if (typeof value !== 'string' || value === 'P' || value.endsWith('T')) return undefined;
	const match = DURATION.exec(value);
	if (!match) return undefined;
	return DURATION_UNITS_MS.reduce((total, unit, index) => total + Number(match[index + 1] ?? 0) * unit, 0);
};

/**
 * Glob match where `*` matches any run of characters except `separator` (when given), `**` any run at all.
 * Iterative (no regular expression is built from data).
 * @param {string} pattern
 * @param {string} value
 * @param {string} [separator]
 * @returns {boolean}
 */
export const globMatch = (pattern, value, separator) => {
	/** @type {Array<[number, number]>} */
	const stack = [[0, 0]];
	const seen = new Set();
	while (stack.length > 0) {
		const [p, v] = /** @type {[number, number]} */ (stack.pop());
		const id = p * (value.length + 1) + v;
		if (seen.has(id)) continue;
		seen.add(id);
		if (p === pattern.length) {
			if (v === value.length) return true;
			continue;
		}
		if (pattern[p] === '*') {
			const double = pattern[p + 1] === '*';
			const next = p + (double ? 2 : 1);
			stack.push([next, v]);
			if (v < value.length && (double || separator === undefined || value[v] !== separator)) stack.push([p, v + 1]);
		} else if (v < value.length && pattern[p] === value[v]) stack.push([p + 1, v + 1]);
	}
	return false;
};

/**
 * Call `fn`, swallowing (and reporting) anything it throws.
 * @template T
 * @param {() => T} fn
 * @param {(error: unknown) => void} [onError]
 * @returns {T | undefined}
 */
export const attempt = (fn, onError) => {
	try {
		return fn();
	} catch (error) {
		try {
			onError?.(error);
		} catch {
			/* a broken error handler must not break the caller */
		}
		return undefined;
	}
};
