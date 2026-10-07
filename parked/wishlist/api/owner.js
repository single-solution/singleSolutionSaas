/**
 * Who a request acts for. Never taken from the request body without a check:
 *
 * - `sk_` (the merchant's server): the customer it names (`customerId`, any opaque id of the merchant's customers), or
 *   nobody (merchant-wide reads and admin actions on any list).
 * - `pk_` (the browser) with `SS-Identity`: the customer of the website's own login (verified by app-kit against the
 *   issuer in the signed entitlement document — the merchant's own login or Signups). A token that fails verification
 *   is refused, never downgraded to a guest.
 * - `pk_` without a login: the guest of a signed guest token (`guest` in the body), only while `guest_merge` is on.
 */
import { isRef } from '../core/item.js';

/** Longest customer subject accepted from a login token. */
export const MAX_SUBJECT = 256;

/** Identity outcomes that mean "no customer login on this request" (anything else is a refused token). */
const ABSENT = new Set(['identity_missing', 'identity_not_configured']);

/**
 * @typedef {import('../adapters/db.js').Owner} Owner
 * @typedef {{ ok: true, owner: Owner | null, server: boolean, email: string | null }
 *   | { ok: false, code: string, detail: string, errors?: Array<{ path: string, code: string }> }} OwnerResult
 */

/**
 * @param {{ ctx: any, site: { websiteId: string, settings: import('./settings.js').Settings },
 *   tokens: import('../adapters/tokens.js').Tokens, guest?: 'allow' | 'deny' }} input
 *   `guest: 'deny'` refuses guests (customer-only actions)
 * @returns {OwnerResult}
 */
export const resolveOwner = ({ ctx, site, tokens, guest = 'allow' }) => {
	const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
	if (ctx.website?.kind === 'sk') {
		const named = body.customerId ?? ctx.query?.customerId;
		if (named === undefined || named === '') return { ok: true, owner: null, server: true, email: null };
		if (!isRef(named))
			return {
				ok: false,
				code: 'validation_failed',
				detail: 'customerId is not a valid id.',
				errors: [{ path: '/customerId', code: 'invalid' }],
			};
		return { ok: true, owner: { kind: 'customer', id: named }, server: true, email: null };
	}
	if (ctx.identity) {
		const subject = String(ctx.identity.subject ?? '');
		if (!subject || subject.length > MAX_SUBJECT)
			return { ok: false, code: 'identity_invalid', detail: 'The customer token has no usable subject.' };
		const email = typeof ctx.identity.email === 'string' ? ctx.identity.email : null;
		return { ok: true, owner: { kind: 'customer', id: subject }, server: false, email };
	}
	if (ctx.identityProblem && !ABSENT.has(ctx.identityProblem))
		return { ok: false, code: 'identity_invalid', detail: `The customer token was refused (${ctx.identityProblem}).` };
	if (guest === 'deny' || !site.settings.enabled('guest_merge'))
		return { ok: false, code: 'identity_required', detail: 'Sign in on the website (SS-Identity) to use this.' };
	if (body.guest === undefined)
		return {
			ok: false,
			code: 'identity_required',
			detail: 'Send SS-Identity, or a guest token from POST /v1/guests as `guest`.',
		};
	const verified = tokens.verifyGuest(body.guest, site.websiteId);
	if (!verified) return { ok: false, code: 'guest_invalid', detail: 'The guest token is invalid or has expired.' };
	return { ok: true, owner: { kind: 'guest', id: verified.guestId }, server: false, email: null };
};
