/**
 * Returns and warranty claims, reviews, wishlist, alerts, compare and reports (PLAN 0.8.8: "Returns and warranty",
 * "Shopper extras", reports of "Admin tools"). Joins the extras' routes (`server/extras-*.js`), their data-rights answers
 * (a person's claims, reviews, wishlist and alerts: the export returns them; the delete removes the wishlist, alerts
 * and reviews, recomputing ratings, and anonymises claims, which keep their amounts) and the settings the visitor
 * widgets need.
 * @module
 */
import { MAX_COMPARE } from '../core/compare.js';
import { createAlerts } from './extras-alerts.js';
import { createCards } from './extras-cards.js';
import { createReports } from './extras-reports.js';
import { createReturns } from './extras-returns.js';
import { createReviews } from './extras-reviews.js';
import { MAX_WISHLIST, createShopperLists } from './extras-shopper.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./routes.js').Person} Person */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createExtras = (product, service) => {
	const cards = createCards(product);
	const returns = createReturns(product, service);
	const reviews = createReviews(product, service);
	const alerts = createAlerts(product, service, cards);
	const lists = createShopperLists(product, service, cards);
	const reports = createReports(product, service);
	const withData = [returns, reviews, lists, alerts];

	return {
		routes: [...returns.routes, ...reviews.routes, ...lists.routes, ...alerts.routes, ...reports.routes],
		exportUser: async (s, user) => {
			/** @type {Record<string, unknown[]>} */
			const records = {};
			for (const part of withData) Object.assign(records, await part.exportUser(s, user));
			return records;
		},
		deleteUser: async (s, user) => {
			const total = { deleted: 0, anonymised: 0 };
			for (const part of withData) {
				const done = await part.deleteUser(s, user);
				total.deleted += done.deleted;
				total.anonymised += done.anonymised;
			}
			return total;
		},
		widgetSettings: async (s) => {
			/** @type {Record<string, unknown>} */
			const settings = {};
			if (s.has('returns')) {
				const { maxPhotos, photoMaxMb } = await s.values('returns');
				settings.returns = { maxPhotos: Number(maxPhotos), photoMaxMb: Number(photoMaxMb) };
			}
			if (s.has('reviews'))
				settings.reviews = { moderation: (await s.values('reviews')).moderation === 'auto' ? 'auto' : 'manual' };
			if (s.has('wishlist')) settings.wishlist = { max: MAX_WISHLIST };
			if (s.has('compare')) {
				const { maxProducts } = await s.values('compare');
				settings.compare = { max: Math.min(MAX_COMPARE, Math.max(2, Number(maxProducts) || MAX_COMPARE)) };
			}
			return settings;
		},
	};
};
