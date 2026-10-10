/**
 * Promotions (PLAN 0.8.8): coupons, deals, bundles and loyalty points for the merchant and the shopper. The merchant's
 * coupons, deals and bundles are in `promotions-offers.js`; here are the loyalty accounts (look up a shopper's points
 * by Accounts user id and adjust them, server token and ticket with `loyalty.manage`), the shopper's routes (the live
 * deals, a product's price after deals, the signed-in shopper's points), the data rights (the loyalty account and the
 * coupon uses of an Accounts user) and the loyalty settings the widgets need.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { givePoints, loyaltyAccount, takePoints } from '../adapters/ledger.js';
import { activeProduct, categoryTrail, deletePerson, loadOffers, personRecords } from '../adapters/promotions-store.js';
import { byShowOrder, publicDeal } from '../core/deals.js';
import { COLLECTIONS } from '../core/model.js';
import { expiringSoon, expiryFor, historyView, loyaltyRules, pointsValue, SHOPPER_HISTORY } from '../core/loyalty.js';
import { quoteProduct } from '../core/promotions.js';
import { checkText, checkWhole } from '../core/promotions-rules.js';
import { createOfferRoutes } from './promotions-offers.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

/** Rate limits of the merchant's server and admin routes. */
const SERVER_RATE = [...SERVER_LIMITS];
/** Rate limits of visitor routes. @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const VISITOR_RATE = [...VISITOR_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').LoyaltyRecord} LoyaltyRecord */

/** Most deals the shopper's deals list shows. */
const MAX_SHOP_DEALS = 50;
/** The largest single adjustment of points. */
const MAX_ADJUST = 1_000_000_000;
/** Tries of a loyalty write when the account changed meanwhile. */
const WRITE_TRIES = 3;

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createPromotions = (product, service) => {
	const { now, invalid } = service;

	/** @param {unknown} value */
	const userIdOf = (value) => {
		const id = typeof value === 'string' ? value : '';
		if (id.length === 0 || id.length > 128) throw problem('not_found', 'No such shopper.');
		return id;
	};

	/**
	 * A loyalty account for the merchant.
	 * @param {Site} s @param {LoyaltyRecord} account
	 */
	const accountView = async (s, account) => {
		const settings = await s.values('loyalty');
		return {
			userId: account.userId,
			balance: account.balance,
			value: pointsValue(account.balance, settings),
			currency: s.currency,
			lots: account.lots.map((lot) => ({
				id: lot.id,
				points: lot.points,
				left: lot.left,
				earnedAt: new Date(lot.earnedAt).toISOString(),
				expiresAt: lot.expiresAt === null ? null : new Date(lot.expiresAt).toISOString(),
				orderId: lot.orderId,
			})),
			history: historyView(account.history),
			expiringSoon: expiringSoon(account.lots, now()),
		};
	};

	/** @param {any} ctx */
	const readAccount = async (ctx) => {
		const s = await service.site(ctx);
		const account = await loyaltyAccount(await s.data(), userIdOf(ctx.params.userId), { now: now() });
		return accountView(s, account);
	};

	/** Add (+) or take (−) points with a note. @param {any} ctx */
	const adjustAccount = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const points = checkWhole(body.points, 'points', { min: -MAX_ADJUST, max: MAX_ADJUST });
		if (!points.ok || points.value === 0)
			return invalid('points', 'points is a whole number other than 0 (negative takes points).');
		const note = checkText(body.note, 'note', { min: 0, max: 200, fallback: '' });
		if (!note.ok) return invalid(note.field, note.message);
		const userId = userIdOf(ctx.params.userId);
		const s = await service.site(ctx);
		const data = await s.data();
		const settings = await s.values('loyalty');
		for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
			const at = now();
			if (points.value > 0) {
				const given = await givePoints(
					data,
					{
						userId,
						points: points.value,
						orderId: null,
						kind: 'adjust',
						expiresAt: expiryFor(at, settings),
						note: note.value,
					},
					{ now: at },
				);
				if (!given) continue;
			} else {
				const account = await loyaltyAccount(data, userId, { now: at });
				if (account.balance < -points.value)
					return invalid('points', `The balance is ${account.balance} points; at most that many can be taken.`, 'too_many');
				const taken = await takePoints(
					data,
					{ userId, points: -points.value, orderId: null, kind: 'adjust', note: note.value },
					{ now: at },
				);
				if (!taken.ok) continue;
			}
			const customer = await data
				.collection(COLLECTIONS.customers)
				.findOne({ websiteId: data.websiteId, userId }, { projection: { _id: 0, name: 1 } });
			await service.log(ctx, 'loyalty.adjusted', userId, {
				label: customer?.name ? String(customer.name) : userId,
				detail: `${points.value > 0 ? '+' : ''}${points.value} points`,
			});
			return accountView(s, await loyaltyAccount(data, userId, { now: now() }));
		}
		return problem('points_changed', 'The points changed meanwhile: try again.');
	};

	return {
		routes: [
			...createOfferRoutes(product, service),

			// ---------------------------------------------------------------------------------- loyalty (merchant)
			defineRoute({
				method: 'GET',
				path: '/v1/loyalty/accounts/:userId',
				auth: 'server',
				feature: 'loyalty',
				rateLimit: SERVER_RATE,
				handler: readAccount,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/loyalty/accounts/:userId',
				auth: 'ticket',
				feature: 'loyalty',
				permission: 'loyalty.manage',
				rateLimit: SERVER_RATE,
				handler: readAccount,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/loyalty/accounts/:userId/adjust',
				auth: 'server',
				feature: 'loyalty',
				idempotent: true,
				rateLimit: SERVER_RATE,
				handler: adjustAccount,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/loyalty/accounts/:userId/adjust',
				auth: 'ticket',
				feature: 'loyalty',
				permission: 'loyalty.manage',
				idempotent: true,
				rateLimit: SERVER_RATE,
				handler: adjustAccount,
			}),

			// --------------------------------------------------------------------------------------------- shopper
			defineRoute({
				method: 'GET',
				path: '/v1/shop/deals',
				auth: 'browser',
				feature: 'deals',
				rateLimit: VISITOR_RATE,
				handler: async (ctx) => {
					const limit = checkWhole(
						ctx.query.limit === undefined || ctx.query.limit === '' ? undefined : Number(ctx.query.limit),
						'limit',
						{ min: 1, max: MAX_SHOP_DEALS, fallback: 10 },
					);
					if (!limit.ok) return invalid(limit.field, limit.message);
					const s = await service.site(ctx);
					const { deals } = await loadOffers(await s.data(), { now: now(), deals: true });
					return { items: [...deals].sort(byShowOrder).slice(0, limit.value).map(publicDeal) };
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/products/:id/quote',
				auth: 'browser',
				feature: 'deals',
				rateLimit: VISITOR_RATE,
				handler: async (ctx) => {
					const s = await service.site(ctx);
					const data = await s.data();
					const found = await activeProduct(data, String(ctx.params.id));
					if (!found) return problem('not_found', 'No such product.');
					const at = now();
					const [categoryIds, { deals }] = await Promise.all([
						categoryTrail(data, found.categoryIds),
						loadOffers(data, { now: at, deals: true }),
					]);
					const variantId = typeof ctx.query.variantId === 'string' ? ctx.query.variantId : null;
					const quote = quoteProduct({ product: found, variantId, deals, now: at, categoryIds, currency: s.currency });
					return quote ?? problem('not_found', 'No such variant.');
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/loyalty',
				auth: 'browser',
				feature: 'loyalty',
				rateLimit: VISITOR_RATE,
				handler: async (ctx) => {
					const s = await service.site(ctx);
					const shopper = await service.requireShopper(s);
					const at = now();
					const account = await loyaltyAccount(await s.data(), shopper.id, { now: at });
					const rules = loyaltyRules(await s.values('loyalty'));
					return {
						balance: account.balance,
						value: account.balance * rules.pointValue,
						currency: s.currency,
						pointValue: rules.pointValue,
						minRedeem: rules.minRedeem,
						maxPercent: rules.maxPercent,
						history: historyView(account.history, SHOPPER_HISTORY),
						expiringSoon: expiringSoon(account.lots, at),
					};
				},
			}),
		],

		exportUser: async (s, user) => {
			/** @type {Record<string, unknown[]>} */
			const none = {};
			if (!user.id) return none;
			const { loyalty, uses } = await personRecords(await s.data(), user.id);
			return {
				loyalty: loyalty
					? [
							{
								userId: loyalty.userId,
								balance: loyalty.balance,
								lots: loyalty.lots,
								history: loyalty.history,
							},
						]
					: [],
				coupon_uses: uses.map((use) => ({ couponId: use.couponId, orderId: use.orderId, createdAt: use.createdAt })),
			};
		},

		deleteUser: async (s, user) => {
			if (!user.id) return { deleted: 0, anonymised: 0 };
			return { deleted: await deletePerson(await s.data(), user.id), anonymised: 0 };
		},

		widgetSettings: async (s) => {
			if (!s.has('loyalty')) return {};
			const { pointValue, minRedeem, maxPercent } = loyaltyRules(await s.values('loyalty'));
			return { loyalty: { pointValue, minRedeem, maxPercent } };
		},
	};
};
