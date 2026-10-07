/**
 * Share links: an owner creates (or rotates) a read-only link to one list, and revokes it at any time. The link carries
 * only an opaque random token — no list id, no customer id, no e-mail — and only the token's hash is stored, so
 * rotating or revoking kills every earlier link at once. The share view shows names and items, never the owner.
 */
import { hashShareToken } from '../adapters/tokens.js';
import { sharedView } from '../core/views.js';
import { failure } from './lists.js';

/**
 * A share URL from the website's template (`{token}` placeholder, https only), else null.
 * @param {string} template
 * @param {string} token
 */
export const shareUrl = (template, token) => {
	if (!template.includes('{token}')) return null;
	try {
		const url = new URL(template.replaceAll('{token}', encodeURIComponent(token)));
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * @param {{ now: () => number, tokens: import('../adapters/tokens.js').Tokens, lists: import('./lists.js').Lists }} deps
 */
export const createShares = ({ now, tokens, lists }) => {
	const DAY_MS = 86_400_000;
	return Object.freeze({
		/**
		 * Create or rotate the share link of a list.
		 * @param {import('./lists.js').Site} site
		 * @param {import('../adapters/db.js').Owner | null} owner
		 * @param {unknown} listId
		 * @returns {Promise<import('./lists.js').Outcome>}
		 */
		create: async (site, owner, listId) => {
			if (typeof listId !== 'string' || listId.length === 0 || listId.length > 64)
				return failure('validation_failed', 'listId is required.', [{ path: '/listId', code: 'required' }]);
			if (owner?.kind === 'guest' && !site.settings.share.allowGuests)
				return failure('share_not_allowed', 'Sign in to share a list.');
			const list = await lists.owned(site, owner, listId);
			if (!list) return failure('not_found', 'No such list.');
			const token = tokens.newShareToken();
			const createdOn = new Date(now()).toISOString();
			const expiresOn =
				site.settings.share.ttlDays > 0 ? new Date(now() + site.settings.share.ttlDays * DAY_MS).toISOString() : null;
			await site.repos.lists.update(list.id, { share: { tokenHash: hashShareToken(token), createdOn, expiresOn } });
			return {
				ok: true,
				status: 201,
				body: {
					listId: list.id,
					token,
					url: shareUrl(site.settings.share.pageUrl, token),
					createdAt: createdOn,
					expiresAt: expiresOn,
				},
			};
		},
		/**
		 * Revoke the share link of a list (safe to repeat).
		 * @param {import('./lists.js').Site} site
		 * @param {import('../adapters/db.js').Owner | null} owner
		 * @param {unknown} listId
		 * @returns {Promise<import('./lists.js').Outcome>}
		 */
		revoke: async (site, owner, listId) => {
			if (typeof listId !== 'string' || listId.length === 0 || listId.length > 64)
				return failure('validation_failed', 'listId is required.', [{ path: '/listId', code: 'required' }]);
			const list = await lists.owned(site, owner, listId);
			if (!list) return failure('not_found', 'No such list.');
			if (list.share) await site.repos.lists.update(list.id, { share: null });
			return { ok: true, body: { listId: list.id, shared: false } };
		},
		/**
		 * The read-only view behind a token.
		 * @param {import('./lists.js').Site} site
		 * @param {unknown} token
		 * @returns {Promise<import('./lists.js').Outcome>}
		 */
		view: async (site, token) => {
			const list = tokens.isShareToken(token) ? await site.repos.lists.byShare(hashShareToken(token)) : null;
			const live = list?.share && (list.share.expiresOn === null || Date.parse(list.share.expiresOn) > now());
			if (!list || !live) return failure('not_found', 'This share link is invalid, expired or was revoked.');
			return { ok: true, body: sharedView(list, { showPrices: site.settings.share.showPrices }) };
		},
	});
};
