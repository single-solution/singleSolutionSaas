/**
 * What the catalog's route modules share: the website, the request body, field problems, the rules a product check
 * needs, the grades list, image addresses, and telling the other parts (alerts) that products changed.
 * @module
 */
import { problem } from '@ss/app-kit';
import { loadRules } from '../adapters/catalog-store.js';
import { isObject } from '../core/catalog.js';
import { gradesByKey } from '../core/grades.js';
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
	 * The website's grades (empty while Grades and serials is off).
	 * @param {Site} s
	 */
	const gradesOf = async (s) => (s.has('grades_serials') ? gradesByKey(await s.list('grades')) : new Map());

	/**
	 * What a product check needs for this website.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const rulesOf = async (s, data) =>
		loadRules(data, {
			variants: s.has('variants'),
			locations: s.has('multi_location'),
			grades: s.has('grades_serials'),
			digital: s.has('digital_goods'),
			bookings: s.has('bookings'),
			gradeKeys: [...(await gradesOf(s)).keys()],
		});

	/**
	 * Tell the other parts (alerts) that products may have changed price, stock or status.
	 * @param {Site} s
	 * @param {Array<Pick<ProductRecord, 'id' | 'price' | 'inStock'>>} before as read before the write (missing = new)
	 * @param {string[]} [ids] the products written (default: those of `before`)
	 */
	const changed = async (s, before, ids = before.map((p) => p.id)) => {
		if (ids.length === 0) return;
		await service.emit('products.changed', s, {
			productIds: [...new Set(ids)],
			before: new Map(before.map((p) => [p.id, { price: p.price, inStock: p.inStock }])),
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

	return Object.freeze({ media, open, gradesOf, rulesOf, changed, storageOf, mediaUrls });
};

/** @typedef {ReturnType<typeof createCatalogCommon>} CatalogCommon */
