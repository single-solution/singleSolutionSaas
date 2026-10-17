/**
 * The shop's policies as the website fills them (PLAN 0.8.10 E3, SF-1, E27): the `policies` list with the return
 * and warranty days of `returns`, the business name and contacts of business.json, and the fee and free-delivery
 * amount of the business country's first plain delivery rate (`delivery_zones`, E5; while that feature is on) as money. Used by the policies
 * routes, the cart's widget config and Chat's store context (E37).
 * @module
 */
import { homeRate } from '../core/delivery.js';
import { fillPolicies } from '../core/policies.js';
import { windowDefaults } from '../core/returns.js';

/** @typedef {import('./service.js').Site} Site */

/**
 * The shop's policies, filled (E3, E27): `{ policies: [{ key, title, text }] }` (text is cleaned HTML), those without text
 * left out.
 * @param {Site} s
 */
export const policiesOf = async (s) => {
	const [list, returns, business, { money, format }] = await Promise.all([
		s.list('policies'),
		s.values('returns'),
		s.business(),
		s.format(),
	]);
	const rate = s.has('delivery_zones') ? homeRate(await s.list('delivery_zones'), String(business.country ?? '')) : null;
	return fillPolicies(/** @type {import('../core/policies.js').Policy[]} */ (list), {
		...windowDefaults(returns),
		locale: format?.locale,
		business: business.name,
		email: business.email ?? '',
		phone: business.phone ?? '',
		address: business.address ?? '',
		deliveryFee: rate ? money(rate.price, s.currency) : '',
		freeDeliveryOver: rate && rate.freeOver > 0 ? money(rate.freeOver, s.currency) : '',
	});
};
