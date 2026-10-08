/**
 * The ticket of the admin widgets (PLAN 0.4.5): kept in memory only, renewed 1 minute before it expires with the
 * page's `getTicket()`. When the page cannot give one, the widgets show `Signed out`.
 * @module
 */

/** A new ticket is asked for this long before the current one expires. */
export const REFRESH_BEFORE_MS = 60_000;

/** @typedef {{ ticket: string, expiresAt: string }} Ticket */
/** @typedef {() => Promise<Ticket>} GetTicket */

/**
 * @param {{ first: Ticket, getTicket: GetTicket, schedule: (task: () => void, ms: number) => number,
 *   cancel: (id: number) => void, now: () => number }} input `first` is the ticket `admin()` already got
 */
export const createTicketSource = ({ first, getTicket, schedule, cancel, now }) => {
	/** @type {string | null} */
	let current = null;
	/** @type {number | null} */
	let timer = null;
	/** @type {Set<(signedIn: boolean) => void>} */
	const listeners = new Set();

	/** @param {Ticket} got */
	const keep = (got) => {
		current = got.ticket;
		timer = schedule(() => void renew(), Math.max(0, Date.parse(got.expiresAt) - now() - REFRESH_BEFORE_MS));
		for (const listener of listeners) listener(true);
	};
	const renew = async () => {
		try {
			const got = await getTicket();
			if (typeof got?.ticket !== 'string') throw new Error('no ticket');
			keep(got);
		} catch {
			current = null;
			for (const listener of listeners) listener(false);
		}
	};
	keep(first);

	return Object.freeze({
		/** The ticket now, or null when signed out. */
		current: () => current,
		/** @param {(signedIn: boolean) => void} listener called after each renewal */
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop: () => {
			if (timer !== null) cancel(timer);
		},
	});
};

/** @typedef {ReturnType<typeof createTicketSource>} TicketSource */
/** @typedef {{ base: string, tickets: TicketSource, fetch: typeof fetch }} AdminApi */

/**
 * A JSON call to an admin route with the current ticket.
 * @param {AdminApi} api
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ ok: boolean, status: number, data: any }>} status 0 when signed out or unreachable
 */
export const adminCall = async ({ base, tickets, fetch }, method, path, body) => {
	const ticket = tickets.current();
	if (!ticket) return { ok: false, status: 0, data: null };
	try {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${ticket}`,
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
