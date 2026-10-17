/**
 * JSON calls of the widgets and the ticket of the admin widgets (PLAN 0.4.5). The ticket is kept in memory only and
 * renewed 1 minute before it expires with the page's `getTicket()`; when the page cannot give one, the source is
 * signed out and the widgets show `Signed out`.
 * @module
 */

/** A new ticket is asked for this long before the current one expires. */
export const REFRESH_BEFORE_MS = 60_000;

/** @typedef {{ ok: boolean, status: number, data: any }} Answer status 0 when signed out or unreachable */
/**
 * @typedef {{ ticket: string, expiresAt: string, signIn?: string }} Ticket `signIn`: the staff member's current Accounts sign-in,
 *   which the store's server may hand over with the ticket so a call that needs another product's staff route (a refund
 *   through Payments) can name the verified person (`SS-Sign-In` next to the ticket)
 */
/** @typedef {() => Promise<Ticket>} GetTicket */

/**
 * A JSON call; never throws. A body is sent as JSON; a 204 or a body that is not JSON answers `data: null`.
 * @param {typeof globalThis.fetch} fetch
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [init]
 * @returns {Promise<Answer>}
 */
export const requestJson = async (fetch, url, { method = 'GET', headers = {}, body } = {}) => {
	try {
		const response = await fetch(url, {
			method,
			headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const data = response.status === 204 ? null : await response.json().catch(() => null);
		return { ok: response.ok, status: response.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	}
};

/**
 * The ticket source of the admin widgets. A ticket whose `expiresAt` is not a time cannot be renewed in time, so it
 * counts as no ticket (signed out).
 * @param {{ first: Ticket, getTicket: GetTicket, schedule: (task: () => void, ms: number) => number,
 *   cancel: (id: number) => void, now: () => number }} input `first` is the ticket `admin()` already got
 */
export const createTicketSource = ({ first, getTicket, schedule, cancel, now }) => {
	/** @type {string | null} */
	let current = null;
	/** @type {string | null} */
	let signIn = null;
	/** @type {number | null} */
	let timer = null;
	let stopped = false;
	/** @type {Set<(signedIn: boolean) => void>} */
	const listeners = new Set();

	/**
	 * Keep a ticket and plan its renewal; false for one without a ticket or a known expiry.
	 * @param {Ticket | null | undefined} got
	 */
	const keep = (got) => {
		const expires = Date.parse(String(got?.expiresAt));
		if (typeof got?.ticket !== 'string' || Number.isNaN(expires)) return false;
		current = got.ticket;
		signIn = typeof got.signIn === 'string' && got.signIn.length > 0 ? got.signIn : null;
		timer = schedule(() => void renew(), Math.max(0, expires - now() - REFRESH_BEFORE_MS));
		return true;
	};
	const renew = async () => {
		timer = null;
		/** @type {Ticket | null} */
		let got = null;
		try {
			got = await getTicket();
		} catch {
			// the page cannot give a ticket: signed out
		}
		if (stopped) return;
		const signedIn = keep(got);
		if (!signedIn) current = null;
		for (const listener of listeners) listener(signedIn);
	};
	keep(first);

	return Object.freeze({
		/** The ticket now, or null when signed out. */
		current: () => current,
		/** The staff member's Accounts sign-in the store's server gave with the ticket, or null. */
		signIn: () => signIn,
		/** @param {(signedIn: boolean) => void} listener called after each renewal */
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Stop renewing (also a renewal on its way). */
		stop: () => {
			stopped = true;
			if (timer !== null) cancel(timer);
			timer = null;
		},
	});
};

/** @typedef {ReturnType<typeof createTicketSource>} TicketSource */
/** @typedef {{ base: string, tickets: Pick<TicketSource, 'current' | 'onChange' | 'stop'> & { signIn?: () => string | null }, fetch: typeof globalThis.fetch }} AdminApi */

/**
 * A JSON call to an admin route with the current ticket.
 * @param {AdminApi} api
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Answer>} status 0 when signed out or unreachable
 */
export const adminCall = async ({ base, tickets, fetch }, method, path, body) => {
	const ticket = tickets.current();
	if (!ticket) return { ok: false, status: 0, data: null };
	const signIn = tickets.signIn?.() ?? null;
	return requestJson(fetch, `${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${ticket}`, ...(signIn ? { 'ss-sign-in': signIn } : {}) },
		body,
	});
};
