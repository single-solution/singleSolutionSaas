/**
 * The acting user of a request (PLAN 0.8.10 K2). A route that changes configuration or works with business data is
 * called with the server token **and** the Accounts sign-in of the staff member (`SS-Sign-In`, `staff.js`); the kit
 * verifies it for the request's own website and sets `ctx.actor` to the person it names:
 * `{ kind: 'user', id, name, role?, email? }`. The product records that person wherever it records an actor (the
 * activity log, histories, replies and notes, Recent changes), and the kit upserts the staff record as it does for a
 * ticket's user (0.4.5).
 *
 * No header the caller wrote is taken as a person: the old `SS-Actor-*` headers are ignored, whatever they say. Without a
 * verified person the actor stays the product's own fallback (`Server`; Chat: `Team`), and only runtime routes (shop
 * reads, sends …) answer such a call.
 * @module
 */

/** @typedef {{ kind: 'user', id: string, name: string, role?: string, email?: string }} ActingUser */
/** @typedef {{ kind: string, id: string, name?: string, role?: string, email?: string }} Actor */

/**
 * Who does what a request does: the ticket's member of the merchant's staff, else the staff member whose verified
 * sign-in a staff route of the server token was called with (K2), else the product's fallback (`Server`).
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
