/**
 * The merchant's coupons, deals and bundles (PLAN 0.8.8 Promotions): create, list, read, edit (switching an offer on
 * or off is an edit of `active`), delete, and a batch of random coupon codes. Each route exists for the merchant's
 * server (`/v1/<offers>`, server token) and for the promotions admin widget (`/v1/admin/<offers>`, ticket with
 * `coupons.edit`, `deals.edit` or `bundles.edit`), sharing one handler. Scopes must name existing products,
 * categories and brands; coupon codes are unique per website. Use counters (`used`) are shown, never written here.
 * Every write goes to the activity log.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { created, defineRoute, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { bundleView, checkBundleInput } from '../core/bundles.js';
import { checkBatchInput, checkCouponInput, couponView, drawCode } from '../core/coupons.js';
import { checkDealInput, dealView } from '../core/deals.js';
import { ID_PREFIX } from '../core/model.js';
import {
	deleteOffer,
	getOffer,
	insertOffers,
	isDuplicate,
	listOffers,
	missingRefs,
	updateOffer,
} from '../adapters/promotions-store.js';
import { SERVER_LIMITS } from './service.js';

/** Rate limits of the merchant's server and admin routes. */
const SERVER_RATE = [...SERVER_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('../adapters/promotions-store.js').OfferCollection} OfferCollection */

/**
 * How each kind of offer is checked, shown, named in the log and given an id.
 * @type {Record<OfferCollection, { check: (input: unknown) => import('../core/promotions-rules.js').Checked,
 *   view: (record: any) => Record<string, unknown>, name: string, prefix: string, label: (record: any) => string }>}
 */
const KINDS = {
	coupons: { check: checkCouponInput, view: couponView, name: 'coupon', prefix: ID_PREFIX.coupon, label: (r) => r.code },
	deals: { check: checkDealInput, view: dealView, name: 'deal', prefix: ID_PREFIX.deal, label: (r) => r.id },
	bundles: { check: checkBundleInput, view: bundleView, name: 'bundle', prefix: ID_PREFIX.bundle, label: (r) => r.id },
};

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createOfferRoutes = (product, service) => {
	const { invalid } = service;

	/** @param {any} ctx */
	const dataOf = async (ctx) => (await service.site(ctx)).data();

	/**
	 * Refuse a scope (or bundle items) naming products, categories or brands that do not exist.
	 * @param {import('@ss/app-kit').WebsiteData} data
	 * @param {Record<string, any>} value checked offer fields
	 */
	const checkRefs = async (data, value) => {
		const scopes = [value.scope, value.getScope].filter(Boolean);
		const refs = {
			productIds: [
				...new Set([
					...scopes.flatMap((scope) => scope.productIds),
					...(value.items ?? []).map((/** @type {any} */ item) => item.productId),
				]),
			],
			categoryIds: [...new Set(scopes.flatMap((scope) => scope.categoryIds))],
			brandIds: [...new Set(scopes.flatMap((scope) => scope.brandIds))],
		};
		const missing = await missingRefs(data, refs);
		for (const key of /** @type {const} */ (['productIds', 'categoryIds', 'brandIds']))
			if (missing[key].length > 0)
				throw invalid(
					`scope/${key}`,
					`Unknown ${key.replace('Ids', '')} ids: ${missing[key].slice(0, 10).join(', ')}.`,
					'unknown',
				);
	};

	/** @param {unknown} error */
	const codeTaken = (error) => {
		if (isDuplicate(error)) return problem('coupon_code_taken', 'This code is already used by another coupon.');
		throw error;
	};

	/** @param {OfferCollection} kind */
	const list = (kind) => async (/** @type {any} */ ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const active = ctx.query.active === 'true' ? true : ctx.query.active === 'false' ? false : undefined;
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim().slice(0, 60) : '';
		const rows = await listOffers(await dataOf(ctx), kind, {
			after: page.after,
			limit: page.fetchLimit,
			...(active === undefined ? {} : { active }),
			...(q ? { q } : {}),
		});
		return page.respond(rows.map(KINDS[kind].view), (view) => [view.createdAt, view.id]);
	};

	/** @param {OfferCollection} kind */
	const read = (kind) => async (/** @type {any} */ ctx) => {
		const found = await getOffer(await dataOf(ctx), kind, String(ctx.params.id));
		return found ? KINDS[kind].view(found) : problem('not_found', `No such ${KINDS[kind].name}.`);
	};

	/** @param {OfferCollection} kind */
	const create = (kind) => async (/** @type {any} */ ctx) => {
		const checked = KINDS[kind].check(ctx.body);
		if (!checked.ok) return invalid(checked.field, checked.message);
		const data = await dataOf(ctx);
		await checkRefs(data, checked.value);
		const record = { id: createId(KINDS[kind].prefix), ...checked.value, used: 0 };
		try {
			await insertOffers(data, kind, [record]);
		} catch (error) {
			return codeTaken(error);
		}
		await service.log(ctx, `${KINDS[kind].name}.created`, KINDS[kind].label(record));
		return created(KINDS[kind].view(/** @type {any} */ (await getOffer(data, kind, record.id))));
	};

	/** @param {OfferCollection} kind */
	const update = (kind) => async (/** @type {any} */ ctx) => {
		if (typeof ctx.body !== 'object' || ctx.body === null || Array.isArray(ctx.body))
			return invalid('', 'Send the fields to change.');
		const data = await dataOf(ctx);
		const id = String(ctx.params.id);
		const found = await getOffer(data, kind, id);
		if (!found) return problem('not_found', `No such ${KINDS[kind].name}.`);
		const checked = KINDS[kind].check({ ...found, ...ctx.body });
		if (!checked.ok) return invalid(checked.field, checked.message);
		await checkRefs(data, checked.value);
		/** @type {any} */
		let changed;
		try {
			changed = await updateOffer(data, kind, id, checked.value);
		} catch (error) {
			return codeTaken(error);
		}
		if (!changed) return problem('not_found', `No such ${KINDS[kind].name}.`);
		await service.log(ctx, `${KINDS[kind].name}.updated`, KINDS[kind].label(changed));
		return KINDS[kind].view(changed);
	};

	/** @param {OfferCollection} kind */
	const remove = (kind) => async (/** @type {any} */ ctx) => {
		const data = await dataOf(ctx);
		const id = String(ctx.params.id);
		const found = await getOffer(data, kind, id);
		if (!found || !(await deleteOffer(data, kind, id))) return problem('not_found', `No such ${KINDS[kind].name}.`);
		await service.log(ctx, `${KINDS[kind].name}.deleted`, KINDS[kind].label(found));
		return undefined;
	};

	/** A batch of coupons with random codes (`{ prefix, count ≤ 500, coupon }`). @param {any} ctx */
	const batch = async (ctx) => {
		const checked = checkBatchInput(ctx.body);
		if (!checked.ok) return invalid(checked.field, checked.message);
		const { prefix, count, coupon } = checked.value;
		const data = await dataOf(ctx);
		await checkRefs(data, coupon);
		let buffer = randomBytes(256);
		let offset = 0;
		const nextByte = () => {
			if (offset >= buffer.length) {
				buffer = randomBytes(256);
				offset = 0;
			}
			const byte = /** @type {number} */ (buffer[offset]);
			offset += 1;
			return byte;
		};
		/** @type {Set<string>} */
		const codes = new Set();
		while (codes.size < count) codes.add(drawCode(prefix, nextByte));
		const records = [...codes].map((code) => ({ id: createId(ID_PREFIX.coupon), ...coupon, code, used: 0 }));
		const ids = new Set(await insertOffers(data, 'coupons', records, { skipDuplicates: true }));
		const made = records.filter((record) => ids.has(record.id));
		await service.log(ctx, 'coupons.generated', `${prefix || '(no prefix)'} × ${made.length}`);
		return created({ created: made.length, codes: made.map((record) => record.code) });
	};

	return [
		// ------------------------------------------------------------------------------------------------ coupons
		defineRoute({
			method: 'GET',
			path: '/v1/coupons',
			auth: 'server',
			feature: 'coupons',
			rateLimit: SERVER_RATE,
			handler: list('coupons'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/coupons',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			rateLimit: SERVER_RATE,
			handler: list('coupons'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/coupons',
			auth: 'server',
			feature: 'coupons',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('coupons'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/coupons',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('coupons'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/coupons/batch',
			auth: 'server',
			feature: 'coupons',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: batch,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/coupons/batch',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: batch,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/coupons/:id',
			auth: 'server',
			feature: 'coupons',
			rateLimit: SERVER_RATE,
			handler: read('coupons'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/coupons/:id',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			rateLimit: SERVER_RATE,
			handler: read('coupons'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/coupons/:id',
			auth: 'server',
			feature: 'coupons',
			rateLimit: SERVER_RATE,
			handler: update('coupons'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/coupons/:id',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			rateLimit: SERVER_RATE,
			handler: update('coupons'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/coupons/:id',
			auth: 'server',
			feature: 'coupons',
			rateLimit: SERVER_RATE,
			handler: remove('coupons'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/coupons/:id',
			auth: 'ticket',
			feature: 'coupons',
			permission: 'coupons.edit',
			rateLimit: SERVER_RATE,
			handler: remove('coupons'),
		}),

		// -------------------------------------------------------------------------------------------------- deals
		defineRoute({
			method: 'GET',
			path: '/v1/deals',
			auth: 'server',
			feature: 'deals',
			rateLimit: SERVER_RATE,
			handler: list('deals'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/deals',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			rateLimit: SERVER_RATE,
			handler: list('deals'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/deals',
			auth: 'server',
			feature: 'deals',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('deals'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/deals',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('deals'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/deals/:id',
			auth: 'server',
			feature: 'deals',
			rateLimit: SERVER_RATE,
			handler: read('deals'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/deals/:id',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			rateLimit: SERVER_RATE,
			handler: read('deals'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/deals/:id',
			auth: 'server',
			feature: 'deals',
			rateLimit: SERVER_RATE,
			handler: update('deals'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/deals/:id',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			rateLimit: SERVER_RATE,
			handler: update('deals'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/deals/:id',
			auth: 'server',
			feature: 'deals',
			rateLimit: SERVER_RATE,
			handler: remove('deals'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/deals/:id',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			rateLimit: SERVER_RATE,
			handler: remove('deals'),
		}),

		// ------------------------------------------------------------------------------------------------ bundles
		defineRoute({
			method: 'GET',
			path: '/v1/bundles',
			auth: 'server',
			feature: 'bundles',
			rateLimit: SERVER_RATE,
			handler: list('bundles'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/bundles',
			auth: 'ticket',
			feature: 'bundles',
			permission: 'bundles.edit',
			rateLimit: SERVER_RATE,
			handler: list('bundles'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/bundles',
			auth: 'server',
			feature: 'bundles',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('bundles'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/bundles',
			auth: 'ticket',
			feature: 'bundles',
			permission: 'bundles.edit',
			idempotent: true,
			rateLimit: SERVER_RATE,
			handler: create('bundles'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/bundles/:id',
			auth: 'server',
			feature: 'bundles',
			rateLimit: SERVER_RATE,
			handler: read('bundles'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/bundles/:id',
			auth: 'ticket',
			feature: 'bundles',
			permission: 'bundles.edit',
			rateLimit: SERVER_RATE,
			handler: read('bundles'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/bundles/:id',
			auth: 'server',
			feature: 'bundles',
			rateLimit: SERVER_RATE,
			handler: update('bundles'),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/bundles/:id',
			auth: 'ticket',
			feature: 'bundles',
			permission: 'bundles.edit',
			rateLimit: SERVER_RATE,
			handler: update('bundles'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/bundles/:id',
			auth: 'server',
			feature: 'bundles',
			rateLimit: SERVER_RATE,
			handler: remove('bundles'),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/bundles/:id',
			auth: 'ticket',
			feature: 'bundles',
			permission: 'bundles.edit',
			rateLimit: SERVER_RATE,
			handler: remove('bundles'),
		}),
	];
};
