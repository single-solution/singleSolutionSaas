/**
 * The shown price of a website's products (SEO audit G4), read once per request: its live deals, the business time,
 * whole units and the deal rules, so cards, the product page, Chat's product answers, structured data and feeds name
 * the same price as the cart (`core/promotions.js` `shownPrice`).
 * @module
 */
import { loadOffers } from '../adapters/promotions-store.js';
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
	 * A website's shown prices now (`of`: for a product with its categories and their ancestors, each variant's), with
	 * the deals within their dates read for them and the business time (none while Deals is off).
	 * @param {Site} s @param {WebsiteData} data
	 * @param {{ allDay?: boolean }} [options] `allDay`: priced only with deals that hold all day on every day (feeds,
	 *   read at the catalogs' own pace)
	 * @returns {Promise<{ deals: import('../core/model.js').DealRecord[], clock: { weekday: number, minutes: number } | null,
	 *   of: (item: ProductRecord, categoryIds: string[]) => (variant: VariantRecord) => ShownPrice }>}
	 */
	async (s, data, { allDay = false } = {}) => {
		if (!s.has('deals')) return { deals: [], clock: null, of: () => listShown };
		const now = service.now();
		const [{ deals }, pricing, settings] = await Promise.all([
			loadOffers(data, { now, deals: true }),
			service.pricing(s),
			s.values('deals'),
		]);
		const live = allDay ? deals.filter(holdsAllDay) : deals;
		const rules = dealRulesOf(settings);
		return {
			deals,
			clock: pricing,
			of: (item, categoryIds) =>
				live.length === 0
					? listShown
					: (variant) =>
							shownPrice({
								product: item,
								variant,
								deals: live,
								now,
								categoryIds,
								clock: pricing,
								unit: pricing.unit,
								rules,
							}),
		};
	};

/** @typedef {ReturnType<typeof createShownPrices>} ShownPrices */
