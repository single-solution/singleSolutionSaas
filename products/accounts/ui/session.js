/**
 * The visitor's session in the browser (PLAN 0.8.6). The sign-in token lives in memory only and is renewed 1 minute
 * before it expires with the refresh token, which is kept in localStorage when the user ticked "Remember me", else in
 * sessionStorage. Every change is announced on `window` (`ss-accounts:signed-in` with `detail: { user }`,
 * `ss-accounts:signed-out`) and to the widgets.
 * @module
 */
import { DEVICE_STORAGE_KEY, REFRESH_STORAGE_KEY, SIGNED_IN_EVENT, SIGNED_OUT_EVENT, SIGN_IN_HEADER } from '../core/widgets.js';

/** A new sign-in is asked for this long before the current one expires. */
export const RENEW_BEFORE_MS = 60_000;
/** A renewal that could not reach Accounts is tried again after this long. */
export const RETRY_MS = 30_000;

const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** @typedef {import('./common.js').Answer} Answer */
/** @typedef {'signed-in' | 'signed-out' | 'user'} SessionChange */

/**
 * @typedef {object} SessionInput
 * @property {Window & typeof globalThis} win
 * @property {string} base Accounts' origin
 * @property {string} token the website's browser token
 * @property {(task: () => void, ms: number) => number} schedule
 * @property {(id: number) => void} cancel
 * @property {() => number} now
 */

/** @param {Window} win @param {'localStorage' | 'sessionStorage'} name @returns {Storage | null} */
const storageOf = (win, name) => {
	try {
		return win[name];
	} catch {
		return null;
	}
};

/** @param {Storage | null} storage @param {string} key @returns {string | null} */
const read = (storage, key) => {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		return null;
	}
};

/** @param {Storage | null} storage @param {string} key @param {string | null} value */
const write = (storage, key, value) => {
	try {
		if (value === null) storage?.removeItem(key);
		else storage?.setItem(key, value);
	} catch {
		// private mode or full: the session lasts for this page only
	}
};

/**
 * @param {SessionInput} input
 */
export const createSession = ({ win, base, token, schedule, cancel, now }) => {
	const local = storageOf(win, 'localStorage');
	const tab = storageOf(win, 'sessionStorage');
	/** @type {string | null} */
	let signIn = null;
	let expiresAt = 0;
	/** @type {string | null} */
	let refreshToken = null;
	/** @type {Record<string, any> | null} */
	let user = null;
	/** @type {number | null} */
	let timer = null;
	/** @type {Promise<string | null> | null} */
	let renewing = null;
	/** @type {string | null} */
	let device = null;
	/** @type {Set<(change: SessionChange) => void>} */
	const listeners = new Set();

	/** @param {SessionChange} change */
	const tell = (change) => {
		for (const listener of [...listeners]) listener(change);
	};

	/**
	 * A JSON call with the browser token (and the sign-in, when given).
	 * @param {string} method @param {string} path @param {unknown} [body] @param {string | null} [current]
	 * @returns {Promise<Answer>}
	 */
	const request = async (method, path, body, current = null) => {
		try {
			const response = await win.fetch(`${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(current ? { [SIGN_IN_HEADER]: current } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const data = response.status === 204 ? null : await response.json().catch(() => null);
			return { ok: response.ok, status: response.status, data };
		} catch {
			return { ok: false, status: 0, data: null };
		}
	};

	const stopTimer = () => {
		if (timer !== null) cancel(timer);
		timer = null;
	};

	/** @param {number} ms */
	const later = (ms) => {
		stopTimer();
		timer = schedule(() => void renew(), Math.max(0, ms));
	};

	/**
	 * Keep a `signed_in` answer: the sign-in in memory, the refresh token in the storage "Remember me" chose.
	 * @param {Record<string, any>} answer
	 */
	const accept = (answer) => {
		const was = user !== null;
		signIn = String(answer.signIn);
		expiresAt = Date.parse(answer.expiresAt);
		refreshToken = String(answer.refreshToken);
		user = answer.user ?? null;
		write(answer.remember ? local : tab, REFRESH_STORAGE_KEY, refreshToken);
		write(answer.remember ? tab : local, REFRESH_STORAGE_KEY, null);
		later(expiresAt - now() - RENEW_BEFORE_MS);
		if (!was) win.dispatchEvent(new win.CustomEvent(SIGNED_IN_EVENT, { detail: { user } }));
		tell(was ? 'user' : 'signed-in');
	};

	/**
	 * Forget the session in this browser (storage and memory) and announce it.
	 * @param {boolean} [announce] announce even when this page was not signed in (a kept session ended)
	 */
	const forget = (announce = false) => {
		const was = announce || user !== null || signIn !== null;
		stopTimer();
		signIn = null;
		expiresAt = 0;
		refreshToken = null;
		user = null;
		write(local, REFRESH_STORAGE_KEY, null);
		write(tab, REFRESH_STORAGE_KEY, null);
		if (was) {
			win.dispatchEvent(new win.CustomEvent(SIGNED_OUT_EVENT));
			tell('signed-out');
		}
	};

	/** A new sign-in from the refresh token; null when signed out. @returns {Promise<string | null>} */
	const renew = () => {
		if (renewing) return renewing;
		const stored = refreshToken ?? read(local, REFRESH_STORAGE_KEY) ?? read(tab, REFRESH_STORAGE_KEY);
		if (!stored) return Promise.resolve(null);
		renewing = (async () => {
			const answer = await request('POST', '/v1/session/refresh', { refreshToken: stored });
			if (answer.ok && answer.data?.status === 'signed_in') {
				accept(answer.data);
				return signIn;
			}
			if (answer.status === 0) {
				// Accounts could not be reached: keep the refresh token and try again soon
				refreshToken = stored;
				later(RETRY_MS);
				return signIn !== null && expiresAt > now() ? signIn : null;
			}
			forget(true);
			return null;
		})().finally(() => {
			renewing = null;
		});
		return renewing;
	};

	/** The current sign-in token (renewed when it expires within a minute), or null. */
	const getSignIn = async () => {
		if (signIn === null) return null;
		if (expiresAt - now() > RENEW_BEFORE_MS) return signIn;
		return renew();
	};

	/**
	 * A call of the signed-in user (`ss-sign-in` header); status 0 when signed out.
	 * @param {string} method @param {string} path @param {unknown} [body]
	 * @returns {Promise<Answer>}
	 */
	const me = async (method, path, body) => {
		const current = await getSignIn();
		if (!current) return { ok: false, status: 0, data: null };
		const answer = await request(method, path, body, current);
		if (answer.status === 401) forget();
		return answer;
	};

	return Object.freeze({
		/** A visitor call with the browser token. */
		call: /** @type {(method: string, path: string, body?: unknown) => Promise<Answer>} */ (
			(method, path, body) => request(method, path, body)
		),
		me,
		accept,
		/** Forget the session in this browser (after "Sign out everywhere"). */
		forget: () => forget(),
		getSignIn,
		/** Restore the session kept in this browser (on start). */
		restore: async () => {
			await renew();
		},
		/** The signed-in user, or null. */
		user: () => user,
		/** @param {Record<string, any>} next the user after a change in My account */
		setUser: (next) => {
			if (user === null) return;
			user = next;
			tell('user');
		},
		/** Sign out here: the session ends at Accounts and is forgotten in this browser. */
		signOut: async () => {
			const current = refreshToken ?? read(local, REFRESH_STORAGE_KEY) ?? read(tab, REFRESH_STORAGE_KEY);
			if (current) await request('POST', '/v1/session/sign-out', { refreshToken: current });
			forget();
		},
		/** This browser's random device id (risk checks), kept in localStorage. */
		deviceId: () => {
			if (device) return device;
			const stored = read(local, DEVICE_STORAGE_KEY);
			if (stored && DEVICE_ID.test(stored)) device = stored;
			else {
				const bytes = win.crypto.getRandomValues(new Uint8Array(32));
				device = [...bytes].map((byte) => ALPHABET[byte % 64]).join('');
				write(local, DEVICE_STORAGE_KEY, device);
			}
			return device;
		},
		/** @param {(change: SessionChange) => void} listener */
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
};

/** @typedef {ReturnType<typeof createSession>} Session */
