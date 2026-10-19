/**
 * Promotions (PLAN 0.8.8): coupons, deals, bundles and loyalty points for the merchant and the shopper. The merchant's
 * coupons, deals and bundles are in `promotions-offers.js`; here are the loyalty accounts (look up a shopper's points
 * by customer id — members and guests alike, K-6 — or Accounts user id and adjust them, server token and ticket with
 * `loyalty.manage`), the shopper's routes (the live
 * deals, a product's price after deals, the signed-in shopper's points), the data rights (the loyalty account and the
 * coupon uses of an Accounts user) and the loyalty settings the widgets need.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { givePoints, loyaltyAccount, takePoints } from '../adapters/ledger.js';
import { dealsLiveNow, deletePerson, pendingPoints, personRecords } from '../adapters/promotions-store.js';
import { byShowOrder, publicDeal } from '../core/deals.js';
import { COLLECTIONS } from '../core/model.js';
import { isCustomerId } from '../core/orders.js';
import {
	expiringSoon,
	expiryFor,
	historyView,
	isLoyaltyMember,
	loyaltyRules,
	pointsValue,
	SHOPPER_HISTORY,
} from '../core/loyalty.js';
import { checkText, checkWhole } from '../core/promotions-rules.js';
import { createMedia } from './catalog-media.js';
import { createOfferRoutes } from './promotions-offers.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

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
	const media = createMedia(product);

	/**
	 * A live deal as shoppers get it, with its banner's address (E18).
	 * @param {import('./service.js').Site} s @param {import('../core/model.js').DealRecord} deal
	 */
	const shopDeal = async (s, deal) => publicDeal(deal, { bannerUrl: await media.mediaUrl(s, deal.banner?.key) });

	/**
	 * Whose account a route names (K-6): a customer id (`cus_…`: the member's account when the customer has an Accounts
	 * user, else the guest's) or an Accounts user id; with the customer's name for the activity log.
	 * @param {import('@ss/app-kit').WebsiteData} data @param {unknown} value
	 * @returns {Promise<{ owner: string | { customerId: string }, name: string }>}
	 */
	const ownerOf = async (data, value) => {
		const ref = typeof value === 'string' ? value : '';
		if (ref.length === 0 || ref.length > 128) throw problem('not_found', 'No such shopper.');
		const customer = await data
			.collection(COLLECTIONS.customers)
			.findOne(
				{ websiteId: data.websiteId, ...(isCustomerId(ref) ? { id: ref } : { userId: ref }) },
				{ projection: { _id: 0, id: 1, userId: 1, name: 1 } },
			);
		if (!customer && isCustomerId(ref)) throw problem('not_found', 'No such shopper.');
		const name = customer?.name ? String(customer.name) : '';
		if (!isCustomerId(ref)) return { owner: ref, name };
		return { owner: customer?.userId ? String(customer.userId) : { customerId: ref }, name };
	};

	/**
	 * A loyalty account for the merchant.
	 * @param {Site} s @param {LoyaltyRecord} account
	 */
	const accountView = async (s, account) => {
		const settings = await s.values('loyalty');
		return {
			userId: account.userId,
			customerId: account.customerId ?? null,
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
		const data = await s.data();
		const { owner } = await ownerOf(data, ctx.params.userId);
		return accountView(s, await loyaltyAccount(data, owner, { now: now() }));
	};

	/** Add (+) or take (−) points with a note. @param {any} ctx */
	const adjustAccount = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const points = checkWhole(body.points, 'points', { min: -MAX_ADJUST, max: MAX_ADJUST });
		if (!points.ok || points.value === 0)
			return invalid('points', 'points is a whole number other than 0 (negative takes points).');
		const note = checkText(body.note, 'note', { min: 0, max: 200, fallback: '' });
		if (!note.ok) return invalid(note.field, note.message);
		const s = await service.site(ctx);
		const data = await s.data();
		const { owner, name } = await ownerOf(data, ctx.params.userId);
		const settings = await s.values('loyalty');
		for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
			const at = now();
			if (points.value > 0) {
				const given = await givePoints(
					data,
					{
						userId: owner,
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
				const account = await loyaltyAccount(data, owner, { now: at });
				if (account.balance < -points.value)
					return invalid('points', `The balance is ${account.balance} points; at most that many can be taken.`, 'too_many');
				const taken = await takePoints(
					data,
					{ userId: owner, points: -points.value, orderId: null, kind: 'adjust', note: note.value },
					{ now: at },
				);
				if (!taken.ok) continue;
			}
			const target = String(ctx.params.userId);
			await service.log(ctx, 'loyalty.adjusted', target, {
				label: name || target,
				detail: `${points.value > 0 ? '+' : ''}${points.value} points`,
			});
			return accountView(s, await loyaltyAccount(data, owner, { now: now() }));
		}
		return problem('points_changed', 'The points changed meanwhile: try again.');
	};

	return {
		routes: [
			...createOfferRoutes(service),

			// ---------------------------------------------------------------------------------- loyalty (merchant)
			defineRoute({
				method: 'GET',
				path: '/v1/loyalty/accounts/:userId',
				auth: 'server',
				permission: 'loyalty.manage',
				feature: 'loyalty',
				rateLimit: SERVER_LIMITS,
				handler: readAccount,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/loyalty/accounts/:userId',
				auth: 'ticket',
				feature: 'loyalty',
				permission: 'loyalty.manage',
				rateLimit: SERVER_LIMITS,
				handler: readAccount,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/loyalty/accounts/:userId/adjust',
				auth: 'server',
				permission: 'loyalty.manage',
				feature: 'loyalty',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: adjustAccount,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/loyalty/accounts/:userId/adjust',
				auth: 'ticket',
				feature: 'loyalty',
				permission: 'loyalty.manage',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: adjustAccount,
			}),

			// --------------------------------------------------------------------------------------------- shopper
			defineRoute({
				method: 'GET',
				path: '/v1/shop/deals',
				auth: 'browser',
				feature: 'deals',
				rateLimit: VISITOR_LIMITS,
				handler: async (ctx) => {
					const limit = checkWhole(
						ctx.query.limit === undefined || ctx.query.limit === '' ? undefined : Number(ctx.query.limit),
						'limit',
						{ min: 1, max: MAX_SHOP_DEALS, fallback: 10 },
					);
					if (!limit.ok) return invalid(limit.field, limit.message);
					const s = await service.site(ctx);
					const deals = await dealsLiveNow(await s.data(), { now: now(), clock: await service.pricing(s) });
					const shown = [...deals].sort(byShowOrder).slice(0, limit.value);
					return { items: await Promise.all(shown.map((deal) => shopDeal(s, deal))) };
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/deals/:ref',
				auth: 'browser',
				feature: 'deals',
				rateLimit: VISITOR_LIMITS,
				handler: async (ctx) => {
					const ref = String(ctx.params.ref);
					const s = await service.site(ctx);
					const deals = await dealsLiveNow(await s.data(), { now: now(), clock: await service.pricing(s) });
					const found = deals.find((deal) => deal.id === ref || (deal.slug && deal.slug === ref));
					return found ? shopDeal(s, found) : problem('not_found', 'There is no such deal on now.');
				},
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/loyalty',
				auth: 'browser',
				feature: 'loyalty',
				rateLimit: VISITOR_LIMITS,
				handler: async (ctx) => {
					const limit = checkWhole(
						ctx.query.limit === undefined || ctx.query.limit === '' ? undefined : Number(ctx.query.limit),
						'limit',
						{ min: 1, max: SHOPPER_HISTORY, fallback: SHOPPER_HISTORY },
					);
					if (!limit.ok) return invalid(limit.field, limit.message);
					const s = await service.site(ctx);
					const shopper = await service.requireShopper(s);
					const at = now();
					const data = await s.data();
					const settings = await s.values('loyalty');
					const timeZone = (await s.format()).timeZone || 'UTC';
					const rules = loyaltyRules(settings);
					// only a loyalty member sees points (the setting memberFlag, E47)
					const record = await data
						.collection(COLLECTIONS.customers)
						.findOne({ websiteId: s.websiteId, userId: shopper.id }, { projection: { _id: 0, loyaltyMember: 1 } });
					if (!isLoyaltyMember(settings, record))
						return {
							member: false,
							balance: 0,
							value: 0,
							currency: s.currency,
							pointValue: rules.pointValue,
							minRedeem: rules.minRedeem,
							maxPercent: rules.maxPercent,
							lifetimeEarned: 0,
							pending: 0,
							history: [],
							expiringSoon: [],
						};
					const account = await loyaltyAccount(data, shopper.id, { now: at, rules: { settings, timeZone } });
					const history = historyView(account.history);
					return {
						member: true,
						balance: account.balance,
						value: account.balance * rules.pointValue,
						currency: s.currency,
						pointValue: rules.pointValue,
						minRedeem: rules.minRedeem,
						maxPercent: rules.maxPercent,
						lifetimeEarned: account.lifetimeEarned ?? 0,
						pending: await pendingPoints(data, shopper.id),
						history: history.slice(0, limit.value),
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
			if (!user.id) return { deleted: 0, anonymized: 0 };
			return { deleted: await deletePerson(await s.data(), user.id), anonymized: 0 };
		},
	};
};
