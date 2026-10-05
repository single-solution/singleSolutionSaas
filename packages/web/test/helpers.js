import { vi } from 'vitest';

export const WEBSITE_ID = 'web_0123456789abcdefghjkmnpqrs';
export const KEY = 'pk_test_eyJhbGciOiJFZERTQSJ9.payload.sig';
export const ENDPOINT = 'https://ingest.example.test/v1/events';

/** A Map-backed Storage. */
export const memoryStorage = () => {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		map,
		/** @param {string} key */
		getItem: (key) => map.get(key) ?? null,
		/** @param {string} key @param {string} value */
		setItem: (key, value) => void map.set(key, String(value)),
		/** @param {string} key */
		removeItem: (key) => void map.delete(key),
		/** @param {string} key */
		json: (key) => JSON.parse(map.get(key) ?? 'null'),
	};
};

/** A storage whose every call throws (privacy mode). */
export const brokenStorage = () => ({
	getItem: () => {
		throw new Error('denied');
	},
	setItem: () => {
		throw new Error('quota');
	},
	removeItem: () => {
		throw new Error('denied');
	},
});

/**
 * A minimal window/document pair built on EventTarget (node environment).
 * @param {{ href?: string, referrer?: string }} [options]
 * @returns {any}
 */
export const fakeWindow = ({
	href = 'https://shop.example.com/products/1?ref=x',
	referrer = 'https://www.google.com/search',
} = {}) => {
	const document = Object.assign(new EventTarget(), { referrer, visibilityState: 'visible' });
	const url = new URL(href);
	return Object.assign(new EventTarget(), { document, location: { href, pathname: url.pathname } });
};

/**
 * A fetch mock answering from a script of responses (`{ status, headers }` or `'network'` to throw).
 * The last entry repeats.
 * @param {...({ status?: number, headers?: Record<string, string> } | 'network')} script
 */
export const scriptedFetch = (...script) => {
	/** @type {Array<{ url: string, init: any, body: any }>} */
	const calls = [];
	const fn = vi.fn(async (/** @type {string} */ url, /** @type {any} */ init) => {
		calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
		const step = script.length > 1 ? script.shift() : script[0];
		if (step === 'network') throw new TypeError('Failed to fetch');
		const status = step?.status ?? 200;
		return { ok: status >= 200 && status < 300, status, headers: new Headers(step?.headers ?? {}) };
	});
	return /** @type {any} */ (Object.assign(fn, { calls }));
};

/** Sequential random bytes so ids are deterministic and distinct. */
export const counterBytes = () => {
	let counter = 0;
	return (/** @type {number} */ length) => {
		counter += 1;
		const bytes = new Uint8Array(length);
		bytes[length - 1] = counter & 255;
		bytes[length - 2] = (counter >> 8) & 255;
		return bytes;
	};
};
