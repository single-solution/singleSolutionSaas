/**
 * The merchant's coupons, deals and bundles (PLAN 0.8.8 Promotions): create, list, read, edit (switching an offer on
 * or off is an edit of `active`), delete, and a batch of random coupon codes. Each route exists for the merchant's
 * server (`/v1/<offers>`, server token) and for the promotions admin widget (`/v1/admin/<offers>`, ticket with
 * `coupons.edit`, `deals.edit` or `bundles.edit`), sharing one handler. Scopes must name existing products,
 * categories and brands; coupon codes are unique per website. Use counters (`used`) are shown, never written here.
 * A deal's banner is uploaded first with a presigned upload under the deal's folder (`ecommerce/deals/<id>/`, as the
 * catalog's photos), then set with an edit, which takes a new key only from that folder. Every write goes to the
 * activity log.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { created, defineRoute, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { bundleView, checkBundleInput } from '../core/bundles.js';
import { checkBatchInput, checkCouponInput, couponView, drawCode } from '../core/coupons.js';
import { checkDealInput, dealView } from '../core/deals.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import {
	deleteOffer,
	getOffer,
	insertOffers,
	isDuplicate,
	listOffers,
	missingRefs,
	updateOffer,
} from '../adapters/promotions-store.js';
import { IMAGE_TYPES } from './catalog-common.js';
import { SERVER_LIMITS } from './service.js';

/** Rate limits of the merchant's server and admin routes. */
const SERVER_RATE = [...SERVER_LIMITS];
/** An upload link lasts this long (seconds), as the catalog's. */
const UPLOAD_SECONDS = 900;

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('../adapters/promotions-store.js').OfferCollection} OfferCollection */

/**
 * How each kind of offer is checked, shown, named in the log and given an id.
 * @type {Record<OfferCollection, { check: (input: unknown, keys?: import('../core/deals.js').BannerKeys) =>
 *   import('../core/promotions-rules.js').Checked,
 *   view: (record: any) => Record<string, unknown>, name: string, prefix: string, label: (record: any) => string }>}
 */
const KINDS = {
	coupons: { check: checkCouponInput, view: couponView, name: 'coupon', prefix: ID_PREFIX.coupon, label: (r) => r.code },
	deals: { check: checkDealInput, view: dealView, name: 'deal', prefix: ID_PREFIX.deal, label: (r) => r.name },
	bundles: { check: checkBundleInput, view: bundleView, name: 'bundle', prefix: ID_PREFIX.bundle, label: (r) => r.name },
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

	/**
	 * Refuse a deal slug another deal uses (E18: `GET /v1/shop/deals/:ref` takes an id or a slug).
	 * @param {import('@ss/app-kit').WebsiteData} data
	 * @param {OfferCollection} kind
	 * @param {Record<string, any>} value checked offer fields
	 * @param {string | null} id the deal being changed
	 */
	const slugFree = async (data, kind, value, id) => {
		if (kind !== 'deals' || !value.slug) return true;
		const other = await data
			.collection(COLLECTIONS.deals)
			.findOne(
				{ websiteId: data.websiteId, slug: value.slug, ...(id ? { id: { $ne: id } } : {}) },
				{ projection: { _id: 0, id: 1 } },
			);
		return other === null;
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
		if (!(await slugFree(data, kind, checked.value, null))) return problem('slug_taken', 'Another deal uses this slug.');
		const record = { id: createId(KINDS[kind].prefix), ...checked.value, used: 0 };
		try {
			await insertOffers(data, kind, [record]);
		} catch (error) {
			return codeTaken(error);
		}
		await service.log(ctx, `${KINDS[kind].name}.created`, record.id, { label: KINDS[kind].label(record) });
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
		// a new banner comes from the deal's own folder (its banner upload); the one it already holds stays valid
		// whatever its folder (an imported one, CA-5)
		const checked = KINDS[kind].check(
			{ ...found, ...ctx.body },
			{ held: found.banner?.key ?? null, folder: `ecommerce/deals/${found.id}/` },
		);
		if (!checked.ok) return invalid(checked.field, checked.message);
		await checkRefs(data, checked.value);
		if (!(await slugFree(data, kind, checked.value, id))) return problem('slug_taken', 'Another deal uses this slug.');
		/** @type {any} */
		let changed;
		try {
			changed = await updateOffer(data, kind, id, checked.value);
		} catch (error) {
			return codeTaken(error);
		}
		if (!changed) return problem('not_found', `No such ${KINDS[kind].name}.`);
		await service.log(ctx, `${KINDS[kind].name}.updated`, changed.id, { label: KINDS[kind].label(changed) });
		return KINDS[kind].view(changed);
	};

	/** @param {OfferCollection} kind */
	const remove = (kind) => async (/** @type {any} */ ctx) => {
		const data = await dataOf(ctx);
		const id = String(ctx.params.id);
		const found = await getOffer(data, kind, id);
		if (!found || !(await deleteOffer(data, kind, id))) return problem('not_found', `No such ${KINDS[kind].name}.`);
		await service.log(ctx, `${KINDS[kind].name}.deleted`, found.id, { label: KINDS[kind].label(found) });
		return undefined;
	};

	/**
	 * POST …/deals/:id/banner/upload `{ type, size }` → a presigned upload of the deal's banner under its folder
	 * (`ecommerce/deals/<id>/`): a JPEG, PNG, WebP or AVIF image up to the catalog setting `imageMaxBytes`, as the
	 * catalog's photos; then the deal is edited with `banner: { key, alt, type, size }`.
	 * @param {any} ctx
	 */
	const bannerUpload = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body) ? ctx.body : {};
		const type = String(body.type ?? '');
		const extension = Object.hasOwn(IMAGE_TYPES, type) ? /** @type {Record<string, string>} */ (IMAGE_TYPES)[type] : '';
		if (!extension) return invalid('type', 'A banner is a JPEG, PNG, WebP or AVIF image.');
		const s = await service.site(ctx);
		const limit = Number((await s.values('catalog')).imageMaxBytes);
		if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > limit)
			return invalid('size', `A banner has at most ${limit} bytes.`);
		const found = await getOffer(await s.data(), 'deals', String(ctx.params.id));
		if (!found) return problem('not_found', 'No such deal.');
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) return problem('storage_not_connected', 'Connect your storage first (Connections).');
		const key = `ecommerce/deals/${found.id}/${createId('img').slice(4).toLowerCase()}.${extension}`;
		const signed = storage.presignPut({ key, contentType: type, contentLength: body.size, expiresIn: UPLOAD_SECONDS });
		return { key, upload: { method: signed.method, url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt } };
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
		await service.log(ctx, 'coupons.generated', `${prefix || '(no prefix)'} × ${made.length}`, {
			label: `${prefix || '(no prefix)'} × ${made.length}`,
			detail: `${made.length} codes made`,
		});
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
		defineRoute({
			method: 'POST',
			path: '/v1/deals/:id/banner/upload',
			auth: 'server',
			feature: 'deals',
			rateLimit: SERVER_RATE,
			handler: bannerUpload,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/deals/:id/banner/upload',
			auth: 'ticket',
			feature: 'deals',
			permission: 'deals.edit',
			rateLimit: SERVER_RATE,
			handler: bannerUpload,
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
