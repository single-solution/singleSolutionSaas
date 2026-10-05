/**
 * Personal data export / anonymisation (the Portal-signed standard routes `POST /v1/data:export` and
 * `POST /v1/data:anonymize`). A subject is a customer: `customerId` or `subject` (their login subject). Wishlist holds
 * a customer's lists (with the e-mail kept for signals when the merchant allows it) and the signals published for them;
 * anonymising deletes both — a list without its owner is of no use to anyone. Guest lists hold no personal data and
 * expire on their own.
 */

/**
 * @param {{ repoFor: (websiteId: string) => Promise<import('./db.js').Repositories>, now: () => number }} deps
 */
export const createPrivacyHandlers = ({ repoFor, now }) => {
	/** @param {Record<string, string> | undefined} subject */
	const customerOf = (subject) => {
		const id = subject?.customerId ?? subject?.subject;
		return typeof id === 'string' && id.length > 0 ? id : null;
	};
	return Object.freeze({
		/** @param {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} input */
		export: async (input) => {
			const repos = await repoFor(input.websiteId);
			const customer = customerOf(input.subject);
			const owner = customer ? /** @type {const} */ ({ kind: 'customer', id: customer }) : null;
			return {
				websiteId: input.websiteId,
				...(input.subject ? { subject: input.subject } : {}),
				exportedAt: new Date(now()).toISOString(),
				collections: owner
					? { lists: await repos.lists.ofOwner(owner, 1000), notifications: await repos.notifications.ofOwner(owner.id) }
					: { lists: [], notifications: [] },
			};
		},
		/** @param {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} input */
		anonymize: async (input) => {
			const repos = await repoFor(input.websiteId);
			const customer = customerOf(input.subject);
			if (!customer) return { websiteId: input.websiteId, anonymized: { lists: 0, notifications: 0 } };
			return {
				websiteId: input.websiteId,
				anonymized: {
					lists: await repos.lists.removeOwner({ kind: 'customer', id: customer }),
					notifications: await repos.notifications.removeOwner(customer),
				},
			};
		},
	});
};
