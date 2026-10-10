/**
 * The shop's policies as the website fills them (PLAN 0.8.10 E3): the `checkout` policy texts with the return and
 * warranty days of `returns` and the business name. Used by the policies routes, the cart's widget config and Chat's
 * store context (E37).
 * @module
 */
import { fillPolicies } from '../core/policies.js';

/** @typedef {import('./service.js').Site} Site */

/**
 * The shop's policies, filled (E3): `{ format, policies }`.
 * @param {Site} s
 */
export const policiesOf = async (s) => {
	const [checkout, returns, business] = await Promise.all([s.values('checkout'), s.values('returns'), s.business()]);
	return fillPolicies(checkout, {
		returnDays: Number(returns.returnDays ?? 0),
		warrantyDays: Number(returns.warrantyDays ?? 0),
		business: business.name,
	});
};
