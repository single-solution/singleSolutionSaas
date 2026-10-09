/**
 * Promotions (admin widget `promotions_admin`, tickets with `coupons.edit`, `deals.edit`, `bundles.edit` and
 * `loyalty.manage`; PLAN 0.8.8 Promotions): a section for each switched-on feature — coupons (with batches of random
 * codes), deals, bundles (bundle items or buy X get Y) and loyalty accounts (look up by Accounts user id, history,
 * adjust points with a note) — from `./admin-offers.js`.
 * @module
 */
import { mountAdmin } from './admin-kit.js';
import { loyaltyTab, offersTab } from './admin-offers.js';
import { createSearches } from './admin-taxonomy.js';

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountPromotionsAdmin = async (input) => {
	mountAdmin(input, 'promotions-admin', 'promotionsAdmin.title', (kit, box) => {
		const { t, has } = kit;
		const searches = createSearches(kit);
		/** @type {Array<'coupons' | 'deals' | 'bundles'>} */
		const kinds = ['coupons', 'deals', 'bundles'];
		box.append(
			kit.sections([
				...kinds
					.filter((kind) => has(kind))
					.map((kind) => ({
						key: kind,
						label: t(`promotionsAdmin.${kind}`),
						render: (/** @type {HTMLElement} */ panel) => offersTab(kit, panel, searches, kind),
					})),
				...(has('loyalty')
					? [
							{
								key: 'loyalty',
								label: t('promotionsAdmin.loyalty'),
								render: (/** @type {HTMLElement} */ panel) => loyaltyTab(kit, panel),
							},
						]
					: []),
			]),
		);
	});
};
