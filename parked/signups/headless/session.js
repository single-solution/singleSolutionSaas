/**
 * Browser session store of the headless cores (Mode B): keeps the tokens of the signed-in customer in the storage the
 * merchant chose (`sessions.browser_storage`: `local`, `session` or `memory` — the caller passes `localStorage`,
 * `sessionStorage` or nothing), refreshes the access token shortly before it expires (single flight; a refresh token
 * that was revoked or replayed signs the customer out), and gives the API client the current access token for
 * `SS-Identity`. Storage and clock are injected, so it runs under SSR and in tests.
 * @module
 */

/** Refresh this long before the access token expires. */
export const REFRESH_EARLY_MS = 30_000;
/** Refresh failures that end the session (anything else, e.g. a network error, keeps it for a retry). */
const TERMINAL = new Set(['refresh_invalid', 'refresh_reused', 'session_ended', 'invalid_credentials']);

/**
 * @typedef {{ accessToken: string, expiresAt: string, refreshToken: string, refreshExpiresAt: string, sessionId: string }} Tokens
 * @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} StorageLike
 */

/**
 * @param {{ storage?: StorageLike | null, key?: string, now?: () => number }} [options]
 */
export const createSessionStore = ({ storage = null, key = 'ss_signups_session', now = Date.now } = {}) => {
	/** @type {Tokens | null} */
	let tokens = null;
	try {
		const raw = storage?.getItem(key);
		const parsed = raw ? JSON.parse(raw) : null;
		if (parsed && typeof parsed.refreshToken === 'string' && typeof parsed.accessToken === 'string') tokens = parsed;
	} catch {
		tokens = null;
	}
	/** @type {Set<(tokens: Tokens | null) => void>} */
	const listeners = new Set();
	/** @type {Promise<boolean> | null} */
	let inflight = null;
	/** @param {Tokens | null} next */
	const set = (next) => {
		tokens = next;
		try {
			if (next) storage?.setItem(key, JSON.stringify(next));
			else storage?.removeItem(key);
		} catch {
			// storage full or blocked: the session lives in memory for this page
		}
		for (const listener of listeners) listener(tokens);
	};
	const alive = () => tokens !== null && Date.parse(tokens.refreshExpiresAt) > now();
	return Object.freeze({
		/** @returns {Tokens | null} */
		current: () => (alive() ? tokens : null),
		/** The access token for `SS-Identity` while it is valid, else null. */
		token: () => (tokens && Date.parse(tokens.expiresAt) - REFRESH_EARLY_MS / 6 > now() ? tokens.accessToken : null),
		/** @param {Tokens} next */
		save: (next) => set({ ...next }),
		clear: () => set(null),
		/**
		 * Make sure a fresh access token is available (refreshing when it expires within {@link REFRESH_EARLY_MS}).
		 * @param {{ refresh: (refreshToken: string) => Promise<{ ok: boolean, value?: any, error?: { code: string } }> }} client
		 * @returns {Promise<boolean>} signed in
		 */
		ensureFresh: (client) => {
			if (!alive() || !tokens) {
				if (tokens) set(null);
				return Promise.resolve(false);
			}
			if (Date.parse(tokens.expiresAt) - REFRESH_EARLY_MS > now()) return Promise.resolve(true);
			const refreshToken = tokens.refreshToken;
			inflight ??= client
				.refresh(refreshToken)
				.then((result) => {
					if (result.ok) {
						set({ ...result.value.tokens });
						return true;
					}
					if (TERMINAL.has(String(result.error?.code))) set(null);
					return tokens !== null;
				})
				.finally(() => {
					inflight = null;
				});
			return inflight;
		},
		/**
		 * @param {(tokens: Tokens | null) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
};

/** @typedef {ReturnType<typeof createSessionStore>} SessionStore */

/**
 * A stable random device id (kept in `storage` when the merchant allows remembering devices).
 * @param {{ storage?: StorageLike | null, random: () => string, key?: string }} input `random` returns ≥ 8 URL-safe chars
 * @returns {string}
 */
export const deviceIdOf = ({ storage = null, random, key = 'ss_signups_device' }) => {
	try {
		const existing = storage?.getItem(key);
		if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
	} catch {
		// unavailable storage: a per-page id
	}
	const id = random()
		.replace(/[^A-Za-z0-9_-]/g, '')
		.slice(0, 64);
	try {
		storage?.setItem(key, id);
	} catch {
		// ignore
	}
	return id;
};
