/**
 * The shown price of a website's products (SEO audit G4), read once per request: its live deals, the business time,
 * whole units and the deal rules, so cards, the product page, Chat's product answers, structured data and feeds name
 * the same price as the cart (`core/promotions.js` `shownPrice`).
 * @module
 */
import { categoryPaths, loadOffers } from '../adapters/promotions-store.js';
import { dealRulesOf, holdsAllDay } from '../core/deals.js';
import { listShown, shownPrice } from '../core/promotions.js';

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/promotions.js').ShownPrice} ShownPrice */

/**
 * @param {Service} service
 */
export const createShownPrices =
	(service) =>
	/**
	 * A website's shown prices now (`of`: each variant's of a product), with the deals within their dates read for them,
	 * the business time and, only while a deal is within its dates, the categories' places in the tree, read once for
	 * every product of the request (`trail`: a product's categories with those above them, as deals match them; none
	 * read while Deals is off or no deal is live).
	 * @param {Site} s @param {WebsiteData} data
	 * @param {{ allDay?: boolean }} [options] `allDay`: priced only with deals that hold all day on every day (feeds,
	 *   read at the catalogs' own pace)
	 * @returns {Promise<{ deals: import('../core/model.js').DealRecord[], clock: { weekday: number, minutes: number } | null,
	 *   trail: (item: { categoryIds: string[] }) => string[],
	 *   of: (item: ProductRecord) => (variant: VariantRecord) => ShownPrice }>}
	 */
	async (s, data, { allDay = false } = {}) => {
		/** @param {{ categoryIds: string[] }} item */
		const own = (item) => item.categoryIds;
		if (!s.has('deals')) return { deals: [], clock: null, trail: own, of: () => listShown };
		const now = service.now();
		const [{ deals }, pricing, settings] = await Promise.all([
			loadOffers(data, { now, deals: true }),
			service.pricing(s),
			s.values('deals'),
		]);
		const live = allDay ? deals.filter(holdsAllDay) : deals;
		const rules = dealRulesOf(settings);
		const paths = deals.length > 0 ? await categoryPaths(data) : null;
		/** @param {{ categoryIds: string[] }} item */
		const trail = (item) =>
			paths ? [...new Set([...item.categoryIds, ...item.categoryIds.flatMap((id) => paths.get(id) ?? [])])] : own(item);
		return {
			deals,
			clock: pricing,
			trail,
			of: (item) => {
				if (live.length === 0) return listShown;
				const categoryIds = trail(item);
				return (variant) =>
					shownPrice({
						product: item,
						variant,
						deals: live,
						now,
						categoryIds,
						clock: pricing,
						unit: pricing.unit,
						rules,
					});
			},
		};
	};

/** @typedef {ReturnType<typeof createShownPrices>} ShownPrices */
