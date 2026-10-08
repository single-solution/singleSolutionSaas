/**
 * The visitor side of the API: the browser token, the Accounts sign-in from `SSChat.identify()` (memory only, sent as
 * `SS-Sign-In`) and the guest key (localStorage with its expiry, sent as `SS-Guest`). Never cookies or URLs.
 * @module
 */
import { GUEST_HEADER, GUEST_STORAGE_KEY, SIGN_IN_HEADER } from '../core/widgets.js';
import { requestJson } from './common.js';

const DAY_MS = 86_400_000;

/**
 * @param {{ win: Window, base: string, token: string, now: () => number }} input
 */
export const createVisitor = ({ win, base, token, now }) => {
	/** @type {string | null} */
	let signIn = null;
	let rememberDays = 90;

	/** The guest key, while it has not expired. @returns {string | null} */
	const guestKey = () => {
		try {
			const kept = JSON.parse(win.localStorage.getItem(GUEST_STORAGE_KEY) ?? 'null');
			if (typeof kept?.key === 'string' && typeof kept.expiresAt === 'number' && kept.expiresAt > now()) return kept.key;
			win.localStorage.removeItem(GUEST_STORAGE_KEY);
		} catch {
			// storage blocked or unreadable: no guest key
		}
		return null;
	};

	return Object.freeze({
		/** @param {unknown} value an Accounts sign-in, or null on sign-out */
		identify: (value) => {
			signIn = typeof value === 'string' && value !== '' ? value : null;
		},
		signedIn: () => signIn !== null,
		guestKey,
		/** Is there anyone to ask the API about? */
		known: () => signIn !== null || guestKey() !== null,
		/** @param {number} days how long a new guest key is kept */
		rememberFor: (days) => {
			rememberDays = days;
		},
		/** @param {unknown} key a guest key from an answer */
		keepGuest: (key) => {
			if (typeof key !== 'string' || key === '') return;
			try {
				win.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ key, expiresAt: now() + rememberDays * DAY_MS }));
			} catch {
				// storage blocked: the guest is new on each page
			}
		},
		/**
		 * @param {string} method @param {string} path @param {unknown} [body]
		 * @returns {Promise<import('./common.js').Answer>}
		 */
		call: (method, path, body) => {
			const key = guestKey();
			return requestJson((input, init) => win.fetch(input, init), `${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(signIn ? { [SIGN_IN_HEADER]: signIn } : {}),
					...(key ? { [GUEST_HEADER]: key } : {}),
				},
				body,
			});
		},
	});
};

/** @typedef {ReturnType<typeof createVisitor>} Visitor */
