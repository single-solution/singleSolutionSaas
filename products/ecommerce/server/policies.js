/**
 * The shop's policies as the website fills them (PLAN 0.8.10 E3, SF-1): the `checkout` policy texts with the return
 * and warranty days of `returns`, the business name and contacts of business.json, and the delivery fee and free
 * delivery amount of `delivery_zones` (where no zone matches; while that feature is on) as money. Used by the policies
 * routes, the cart's widget config and Chat's store context (E37).
 * @module
 */
import { fillPolicies } from '../core/policies.js';

/** @typedef {import('./service.js').Site} Site */

/**
 * The shop's policies, filled (E3): `{ format, policies }`.
 * @param {Site} s
 */
export const policiesOf = async (s) => {
	const [checkout, returns, business, { money }] = await Promise.all([
		s.values('checkout'),
		s.values('returns'),
		s.business(),
		s.format(),
	]);
	const zones = s.has('delivery_zones') ? await s.values('delivery_zones') : null;
	const fee = Number(zones?.defaultFee ?? 0);
	const freeOver = Number(zones?.defaultFreeOver ?? 0);
	return fillPolicies(checkout, {
		returnDays: Number(returns.returnDays ?? 0),
		warrantyDays: Number(returns.warrantyDays ?? 0),
		business: business.name,
		email: business.email ?? '',
		phone: business.phone ?? '',
		address: business.address ?? '',
		deliveryFee: zones ? money(fee, s.currency) : '',
		freeDeliveryOver: zones && freeOver > 0 ? money(freeOver, s.currency) : '',
	});
};
