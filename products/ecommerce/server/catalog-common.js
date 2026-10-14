/**
 * What the catalog's route modules share: the website, the request body, field problems, the rules a product check
 * needs, the grades list, image addresses, and telling the other parts (alerts) that products changed.
 * @module
 */
import { problem } from '@ss/app-kit';
import { loadRules } from '../adapters/catalog-store.js';
import { COLLECTIONS } from '../core/model.js';
import { isObject } from '../core/catalog.js';
import { gradeTypes, gradesByKey } from '../core/grades.js';
import { createMedia } from './catalog-media.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/catalog.js').FieldError} FieldError */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** @typedef {{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }} RateLimit */

/** Rate limits of the staff routes (server token and tickets). */
export const STAFF_LIMITS = /** @type {RateLimit[]} */ ([...SERVER_LIMITS]);
/** Rate limits of the shopper routes. */
export const SHOP_LIMITS = /** @type {RateLimit[]} */ ([...VISITOR_LIMITS]);

/** Image types the catalog stores. */
export const IMAGE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' });

/**
 * A 422 `validation_failed` listing every field problem.
 * @param {FieldError[]} errors
 */
export const refuse = (errors) =>
	problem('validation_failed', errors[0]?.message ?? 'The request is not valid.', {
		errors: errors.map((error) => ({ path: error.path, message: error.message, code: 'invalid' })),
	});

/**
 * The request body as an object ({} when missing).
 * @param {any} ctx
 * @returns {Record<string, any>}
 */
export const bodyOf = (ctx) => (isObject(ctx.body) ? ctx.body : {});

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createCatalogCommon = (product, service) => {
	const media = createMedia(product);

	/** @param {any} ctx */
	const open = async (ctx) => {
		const s = await service.site(ctx);
		return { s, data: await s.data() };
	};

	/**
	 * The website's grades list as saved (empty while Condition grades and unit numbers is off); {@link gradesFor} picks a product's.
	 * @param {Site} s
	 * @returns {Promise<import('../core/grades.js').Grade[]>}
	 */
	const gradeListOf = async (s) => (s.has('grades_serials') ? await s.list('grades') : []);

	/**
	 * The website's grades by key where no category is known (empty while Condition grades and unit numbers is off; E45).
	 * @param {Site} s
	 */
	const gradesOf = async (s) => gradesByKey(await gradeListOf(s));

	/**
	 * What a product check needs for this website.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const rulesOf = async (s, data) => ({
		...(await loadRules(data, {
			variants: s.has('variants'),
			locations: s.has('multi_location'),
			grades: s.has('grades_serials'),
			digital: s.has('digital_goods'),
			bookings: s.has('bookings'),
			parcels: s.has('delivery_zones'),
			gradeKeys: [...(await gradesOf(s)).keys()],
			gradeTypes: gradeTypes(await gradeListOf(s)),
			types: await s.list('item_types'),
		})),
		sizeCharts: s.has('size_charts'),
		sizeChartIds: new Set(
			s.has('size_charts')
				? (await data.collection(COLLECTIONS.sizeCharts).distinct('id', { websiteId: data.websiteId })).map(String)
				: [],
		),
	});

	/**
	 * A photo as shoppers get it (E6): its address, text, type, size and placeholder, and its smaller copies' addresses.
	 * @param {Site} s @param {import('../core/model.js').MediaRecord} file @param {string} [fallbackAlt]
	 * @returns {Promise<import('../core/catalog-views.js').MediaView>}
	 */
	const mediaView = async (s, file, fallbackAlt = '') => {
		/** @type {Partial<Record<'thumb' | 'card' | 'detail', string | null>>} */
		const sizes = {};
		for (const [name, key] of Object.entries(file.sizes ?? {}))
			sizes[/** @type {'thumb' | 'card' | 'detail'} */ (name)] = await media.mediaUrl(s, key);
		return {
			url: await media.mediaUrl(s, file.key),
			alt: file.alt || fallbackAlt,
			type: file.type,
			...(file.width ? { width: file.width } : {}),
			...(file.height ? { height: file.height } : {}),
			...(file.blur ? { blur: file.blur } : {}),
			...(Object.keys(sizes).length > 0 ? { sizes } : {}),
		};
	};

	/**
	 * Tell the other parts (alerts, stock events) that products may have changed price, stock or status.
	 * @param {Site} s
	 * @param {Array<Pick<ProductRecord, 'id' | 'price' | 'inStock' | 'variants'>>} before as read before the write
	 *   (missing = new)
	 * @param {string[]} [ids] the products written (default: those of `before`)
	 */
	const changed = async (s, before, ids = before.map((p) => p.id)) => {
		if (ids.length === 0) return;
		await service.emit('products.changed', s, {
			productIds: [...new Set(ids)],
			before: new Map(
				before.map((p) => [
					p.id,
					{ price: p.price, inStock: p.inStock, stock: new Map(p.variants.map((variant) => [variant.id, variant.stock])) },
				]),
			),
		});
	};

	/**
	 * The merchant's storage, or 503 `storage_not_connected`.
	 * @param {Site} s
	 */
	const storageOf = async (s) => {
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Connect your storage first (Connections).');
		return storage;
	};

	/**
	 * The addresses of a product's images.
	 * @param {Site} s @param {ProductRecord} item
	 */
	const mediaUrls = (s, item) => Promise.all(item.media.map((file) => media.mediaUrl(s, file.key)));

	/**
	 * The addresses of each variant's photos (E6).
	 * @param {Site} s @param {ProductRecord} item
	 * @returns {Promise<Map<string, Array<string | null>>>}
	 */
	const variantMediaUrls = async (s, item) =>
		new Map(
			await Promise.all(
				item.variants.map(
					async (variant) =>
						/** @type {[string, Array<string | null>]} */ ([
							variant.id,
							await Promise.all((variant.media ?? []).map((file) => media.mediaUrl(s, file.key))),
						]),
				),
			),
		);

	/**
	 * Check files the staff named that are new to a record (a product video, variant photos) in the bucket: they must
	 * exist with one of `types` and at most `maxBytes`. Answers each file's type and size.
	 * @param {Site} s
	 * @param {string[]} keys
	 * @param {{ types: readonly string[], maxBytes: number, path: string, what: string }} rules
	 * @returns {Promise<Map<string, { type: string, size: number }>>}
	 */
	const fileFacts = async (s, keys, { types, maxBytes, path, what }) => {
		/** @type {Map<string, { type: string, size: number }>} */
		const out = new Map();
		if (keys.length === 0) return out;
		const storage = await storageOf(s);
		for (const key of keys) {
			const head = await storage.headObject({ key }).catch(() => {
				throw problem('upstream_error', 'Your storage cannot be reached right now.');
			});
			if (!head.exists) throw refuse([{ path, message: `${what} is not uploaded.` }]);
			const type = String(head.contentType ?? '')
				.replace(/;.*$/, '')
				.trim();
			if (!types.includes(type) || head.size > maxBytes)
				throw refuse([{ path, message: `${what} is not of an allowed type and size.` }]);
			out.set(key, { type, size: head.size });
		}
		return out;
	};

	/**
	 * Send changed page addresses to search engines through Growth's IndexNow, right after the request, when the
	 * `seo` setting `indexNowOnSave` is on and the Growth token is pasted (E16). Failures are only logged.
	 * @param {Site} s
	 * @param {string[]} urls
	 */
	const indexNow = async (s, urls) => {
		if (urls.length === 0 || !s.has('seo') || (await s.values('seo')).indexNowOnSave !== true) return;
		if (typeof s.ctx.after !== 'function') return;
		s.ctx.after(async () => {
			const sent = await product.callProduct(s.websiteId, 'growth', '/v1/indexnow', {
				method: 'POST',
				body: { urls: [...new Set(urls)] },
			});
			if (!sent.ok) s.ctx.log?.warn?.('indexnow not sent', { reason: sent.reason });
		});
	};

	return Object.freeze({
		media,
		open,
		gradesOf,
		gradeListOf,
		rulesOf,
		changed,
		storageOf,
		mediaUrls,
		mediaView,
		variantMediaUrls,
		fileFacts,
		indexNow,
	});
};

/** @typedef {ReturnType<typeof createCatalogCommon>} CatalogCommon */
