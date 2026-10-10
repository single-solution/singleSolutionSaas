/**
 * The acting user on server-token calls (PLAN 0.8.10 K2). Any server-token request may name the member of the
 * merchant's staff it acts for:
 *
 * - `SS-Actor-Id`: 1–64 characters of `A–Z a–z 0–9 _ . : @ -` (the Accounts user id when the store uses Accounts);
 * - `SS-Actor-Name`: percent-encoded UTF-8, at most 120 characters once decoded;
 * - `SS-Actor-Role` (optional): percent-encoded UTF-8, at most 40 characters once decoded;
 * - `SS-Actor-Email` (optional): an e-mail address, at most 320 characters.
 *
 * Id and name come together; any other combination, or a value that does not fit, is malformed (400 `invalid_actor`).
 * Without the headers the actor stays the product's own fallback (`Server`; Chat: `Team`). The headers grant nothing:
 * the server token stays all-powerful. The product records `{ kind: 'user', id, name, role }` wherever it records an
 * actor, and the kit upserts the staff record as it does for a ticket's user (0.4.5).
 * @module
 */

/** @typedef {{ kind: 'user', id: string, name: string, role?: string, email?: string }} ActingUser */
/** @typedef {{ kind: string, id: string, name?: string, role?: string, email?: string }} Actor */

export const ACTOR_HEADERS = Object.freeze({
	id: 'ss-actor-id',
	name: 'ss-actor-name',
	role: 'ss-actor-role',
	email: 'ss-actor-email',
});

const ACTOR_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_ROLE = 40;
const MAX_EMAIL = 320;

/**
 * A percent-encoded UTF-8 header value, decoded; null when it does not decode or has control characters.
 * @param {string} raw
 * @returns {string | null}
 */
const decoded = (raw) => {
	/** @type {string} */
	let text;
	try {
		text = decodeURIComponent(raw);
	} catch {
		return null;
	}
	return [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ? null : text.trim();
};

/**
 * The acting user named by a request's `SS-Actor-*` headers.
 * @param {Headers} headers
 * @returns {{ ok: true, actor: ActingUser | null } | { ok: false, message: string }}
 */
export const parseActor = (headers) => {
	const raw = {
		id: headers.get(ACTOR_HEADERS.id),
		name: headers.get(ACTOR_HEADERS.name),
		role: headers.get(ACTOR_HEADERS.role),
		email: headers.get(ACTOR_HEADERS.email),
	};
	if (Object.values(raw).every((value) => value === null)) return { ok: true, actor: null };
	if (raw.id === null || raw.name === null)
		return {
			ok: false,
			message: 'Send SS-Actor-Id and SS-Actor-Name together (SS-Actor-Role and SS-Actor-Email are optional).',
		};
	if (!ACTOR_ID.test(raw.id)) return { ok: false, message: 'SS-Actor-Id is 1–64 characters of letters, digits and _ . : @ -.' };
	const name = decoded(raw.name);
	if (name === null || name.length === 0 || name.length > MAX_NAME)
		return { ok: false, message: `SS-Actor-Name is percent-encoded UTF-8 text of 1–${MAX_NAME} characters.` };
	const role = raw.role === null ? null : decoded(raw.role);
	if (raw.role !== null && (role === null || role.length === 0 || role.length > MAX_ROLE))
		return { ok: false, message: `SS-Actor-Role is percent-encoded UTF-8 text of 1–${MAX_ROLE} characters.` };
	const email = raw.email === null ? null : raw.email.trim().toLowerCase();
	if (email !== null && (email.length > MAX_EMAIL || !EMAIL.test(email)))
		return { ok: false, message: 'SS-Actor-Email is an e-mail address.' };
	return {
		ok: true,
		actor: { kind: 'user', id: raw.id, name, ...(role ? { role } : {}), ...(email ? { email } : {}) },
	};
};

/**
 * Who does what a request does: the ticket's member of the merchant's staff, else the acting user a server-token call
 * named (K2), else the product's fallback (`Server`, or Chat's `Team`).
 * @template {Actor} F
 * @param {{ ticket?: { user: { id: string, name: string, email?: string } } | null, actor?: ActingUser | null }} ctx
 * @param {F} fallback
 * @returns {Actor | F}
 */
export const actorOf = (ctx, fallback) => {
	if (ctx.ticket)
		return {
			kind: 'staff',
			id: String(ctx.ticket.user.id),
			name: String(ctx.ticket.user.name),
			...(ctx.ticket.user.email ? { email: String(ctx.ticket.user.email) } : {}),
		};
	return ctx.actor ?? fallback;
};
