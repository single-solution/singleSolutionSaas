/**
 * Catalog images in the merchant's own storage (PLAN 0.8.8: media in the merchant's own storage): a short presigned
 * upload (the bucket refuses another type or size) for a product image, a category image or a brand logo, then the
 * uploaded file is checked in the bucket and attached to its record; product images are reordered (the first is the
 * main image) and removed (the file is deleted from the bucket). Images are JPEG, PNG, WebP or AVIF up to the
 * `catalog` setting `imageMaxBytes`. New keys are under the record's folder; keys a product already holds (imported
 * ones in their own folders) stay valid when its photos are rearranged, and only files under the record's folder are
 * ever deleted (CA-5).
 * @module
 */
import { createId } from '@ss/contracts';
import { defineRoute, problem } from '@ss/app-kit';
import { NO_ID } from '../adapters/catalog-store.js';
import { LIMITS, cleanText, heldKeys, isObject } from '../core/catalog.js';
import { VIDEO_TYPES, mediaExtras } from '../core/catalog-content.js';
import { COLLECTIONS } from '../core/model.js';
import { IMAGE_TYPES, bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').MediaRecord} MediaRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** An upload link lasts this long (seconds). */
const UPLOAD_SECONDS = 900;

/** What an image can belong to: the collection, the storage folder and the activity name. */
const OWNERS = Object.freeze({
	product: { collection: COLLECTIONS.products, folder: 'products', action: 'product' },
	category: { collection: COLLECTIONS.categories, folder: 'categories', action: 'category' },
	brand: { collection: COLLECTIONS.brands, folder: 'brands', action: 'brand' },
});

/** @typedef {keyof typeof OWNERS} Owner */

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogFiles = (product, service, common) => {
	/** @param {Site} s */
	const maxBytes = async (s) => Number((await s.values('catalog')).imageMaxBytes);

	/**
	 * The record an image belongs to, or 404.
	 * @param {WebsiteData} data @param {Owner} owner @param {string} id
	 */
	const recordOf = async (data, owner, id) => {
		const found = await data.collection(OWNERS[owner].collection).findOne({ websiteId: data.websiteId, id }, NO_ID);
		if (!found) throw problem('not_found', `There is no such ${owner}.`);
		return /** @type {Record<string, any>} */ (found);
	};

	/**
	 * Check an uploaded file in the bucket and describe it.
	 * @param {Site} s @param {Owner} owner @param {string} id @param {Record<string, any>} body
	 * @returns {Promise<MediaRecord>}
	 */
	const uploaded = async (s, owner, id, body) => {
		const storage = await common.storageOf(s);
		const key = typeof body.key === 'string' ? body.key : '';
		if (!key.startsWith(`ecommerce/${OWNERS[owner].folder}/${id}/`) || key.includes('..'))
			throw refuse([{ path: '/key', message: 'Give the key of the upload made for this record.' }]);
		const alt = body.alt === undefined ? '' : cleanText(body.alt, LIMITS.alt);
		if (alt === null) throw refuse([{ path: '/alt', message: `Alternative text has at most ${LIMITS.alt} characters.` }]);
		const head = await storage.headObject({ key }).catch(() => {
			throw problem('upstream_error', 'Your storage cannot be reached right now.');
		});
		if (!head.exists) throw refuse([{ path: '/key', message: 'The file has not been uploaded.' }]);
		const type = String(head.contentType ?? '')
			.replace(/;.*$/, '')
			.trim();
		if (!Object.hasOwn(IMAGE_TYPES, type) || head.size > (await maxBytes(s))) {
			await storage.deleteObject({ key }).catch(() => null);
			throw refuse([{ path: '/key', message: 'The file is not an image of an allowed type and size.' }]);
		}
		// the smaller copies the uploader made, their size and placeholder (E6)
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		const extras = mediaExtras(body, `ecommerce/${OWNERS[owner].folder}/${id}/`, '', errors);
		if (errors.length > 0) throw refuse(errors);
		for (const [name, sized] of Object.entries(extras.sizes ?? {})) {
			const found = await storage.headObject({ key: sized }).catch(() => ({ exists: false }));
			if (!found.exists) throw refuse([{ path: `/sizes/${name}`, message: 'This size has not been uploaded.' }]);
		}
		return { key, type, size: head.size, alt, ...extras };
	};

	/** @param {Site} s @param {MediaRecord} file */
	const withUrl = async (s, file) => ({ ...file, url: await common.media.mediaUrl(s, file.key) });

	/**
	 * Delete a record's file from the bucket: only one under the record's own folder (a key an import kept in another
	 * folder may be shared with other records, so it stays, CA-5).
	 * @param {Site} s @param {string} key @param {Owner} owner @param {string} id
	 */
	const deleteFile = async (s, key, owner, id) => {
		if (!key.startsWith(`ecommerce/${OWNERS[owner].folder}/${id}/`)) return;
		const storage = await product.connections.storage(s.websiteId);
		if (storage) await storage.deleteObject({ key }).catch(() => null);
	};

	/**
	 * POST …/uploads `{ for, id, type, size }` → a presigned upload: an image (also each smaller copy of a photo, E6),
	 * or a product video (MP4 or WebM up to `videoMaxBytes`, E4).
	 * @param {any} ctx
	 */
	const upload = async (ctx) => {
		const body = bodyOf(ctx);
		const owner = /** @type {Owner} */ (body.for);
		if (!Object.hasOwn(OWNERS, owner)) throw refuse([{ path: '/for', message: 'Upload for a product, category or brand.' }]);
		const type = String(body.type);
		const video = owner === 'product' && Object.hasOwn(VIDEO_TYPES, type);
		const extension = video
			? /** @type {Record<string, string>} */ (VIDEO_TYPES)[type]
			: /** @type {Record<string, string>} */ (IMAGE_TYPES)[type];
		if (!extension)
			throw refuse([{ path: '/type', message: 'Images are JPEG, PNG, WebP or AVIF; product videos MP4 or WebM.' }]);
		const { s, data } = await common.open(ctx);
		const limit = video ? Number((await s.values('catalog')).videoMaxBytes) : await maxBytes(s);
		if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > limit)
			throw refuse([{ path: '/size', message: `${video ? 'A video' : 'An image'} has at most ${limit} bytes.` }]);
		const record = await recordOf(data, owner, String(body.id));
		const storage = await common.storageOf(s);
		// a descriptive name (SEO audit G14): the record's slug, a product photo's number, and a short id that keeps names
		// apart; keys already stored are never renamed
		const number = owner === 'product' && !video ? `-${(record.media?.length ?? 0) + 1}` : '';
		const name = `${record.slug}${number}-${createId('img').slice(-10).toLowerCase()}`;
		const key = `ecommerce/${OWNERS[owner].folder}/${record.id}/${name}.${extension}`;
		const signed = storage.presignPut({ key, contentType: type, contentLength: body.size, expiresIn: UPLOAD_SECONDS });
		return { key, upload: { method: signed.method, url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt } };
	};

	/** @param {Site} s @param {MediaRecord[]} media */
	const mediaView = async (s, media) => ({ media: await Promise.all(media.map((file) => withUrl(s, file))) });

	/** POST /products/:id/media `{ key, alt }`. @param {any} ctx */
	const attach = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const record = await recordOf(data, 'product', String(ctx.params.id));
		if (record.media.length >= LIMITS.media) throw problem('conflict', `A product has at most ${LIMITS.media} images.`);
		const file = await uploaded(s, 'product', record.id, bodyOf(ctx));
		await data.collection(COLLECTIONS.products).updateOne(
			{ websiteId: data.websiteId, id: record.id, 'media.key': { $ne: file.key } },
			// a new photo is a change of what its page shows: the sitemap's lastmod (SEO audit G8.4)
			{ $push: { media: file }, $set: { contentUpdatedAt: new Date(service.now()) } },
		);
		await service.log(ctx, 'product.image_added', record.id, { label: String(record.name) });
		await common.changed(s, [/** @type {any} */ (record)]);
		return mediaView(s, (await recordOf(data, 'product', record.id)).media);
	};

	/** PUT /products/:id/media `{ items: [{ key, alt }] }`: the same images in a new order, with their texts. @param {any} ctx */
	const arrange = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const record = await recordOf(data, 'product', String(ctx.params.id));
		const body = bodyOf(ctx);
		/** @type {MediaRecord[]} */
		const current = record.media;
		const items = Array.isArray(body.items) ? body.items : null;
		const keys = items?.map((item) => (isObject(item) ? item.key : null)) ?? [];
		if (
			!items ||
			keys.length !== current.length ||
			new Set(keys).size !== keys.length ||
			!current.every((file) => keys.includes(file.key))
		)
			throw refuse([{ path: '/items', message: 'List every image of the product once.' }]);
		/** @type {MediaRecord[]} */
		const media = [];
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		// sizes the product already holds stay valid whatever their folder (CA-5)
		const held = heldKeys(/** @type {import('../core/model.js').ProductRecord} */ (record));
		items.forEach((item, index) => {
			const file = /** @type {MediaRecord} */ (current.find((f) => f.key === item.key));
			const alt = item.alt === undefined ? file.alt : cleanText(item.alt, LIMITS.alt);
			if (alt === null)
				throw refuse([{ path: `/items/${index}/alt`, message: `Alternative text has at most ${LIMITS.alt} characters.` }]);
			media.push({ ...file, alt, ...mediaExtras(item, `ecommerce/products/${record.id}/`, `/items/${index}`, errors, held) });
		});
		if (errors.length > 0) throw refuse(errors);
		await data
			.collection(COLLECTIONS.products)
			.updateOne({ websiteId: data.websiteId, id: record.id }, { $set: { media, contentUpdatedAt: new Date(service.now()) } });
		await service.log(ctx, 'product.images_arranged', record.id, { label: String(record.name) });
		await common.changed(s, [/** @type {any} */ (record)]);
		return mediaView(s, media);
	};

	/** DELETE /products/:id/media?key=. @param {any} ctx */
	const detach = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const record = await recordOf(data, 'product', String(ctx.params.id));
		const key = String(ctx.query.key ?? '');
		if (!record.media.some((/** @type {MediaRecord} */ file) => file.key === key))
			throw problem('not_found', 'The product has no such image.');
		await data
			.collection(COLLECTIONS.products)
			.updateOne(
				{ websiteId: data.websiteId, id: record.id },
				{ $pull: { media: { key }, 'variants.$[].media': { key } }, $set: { contentUpdatedAt: new Date(service.now()) } },
			);
		const removed = /** @type {MediaRecord} */ (record.media.find((/** @type {MediaRecord} */ file) => file.key === key));
		for (const sized of [key, ...Object.values(removed.sizes ?? {})]) await deleteFile(s, sized, 'product', record.id);
		await service.log(ctx, 'product.image_removed', record.id, { label: String(record.name) });
		await common.changed(s, [/** @type {any} */ (record)]);
		return mediaView(s, (await recordOf(data, 'product', record.id)).media);
	};

	/**
	 * The single image of a category (`image`) or brand (`logo`): set or remove.
	 * @param {'category' | 'brand'} owner @param {'image' | 'logo'} field
	 */
	const single = (owner, field) => ({
		/** @param {any} ctx */
		set: async (ctx) => {
			const { s, data } = await common.open(ctx);
			const record = await recordOf(data, owner, String(ctx.params.id));
			const file = await uploaded(s, owner, record.id, bodyOf(ctx));
			await data
				.collection(OWNERS[owner].collection)
				.updateOne({ websiteId: data.websiteId, id: record.id }, { $set: { [field]: file } });
			if (record[field] && record[field].key !== file.key) await deleteFile(s, record[field].key, owner, record.id);
			await service.log(ctx, `${owner}.${field}_set`, record.id, { label: String(record.name) });
			return { [field]: await withUrl(s, file) };
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { s, data } = await common.open(ctx);
			const record = await recordOf(data, owner, String(ctx.params.id));
			if (record[field]) {
				await data
					.collection(OWNERS[owner].collection)
					.updateOne({ websiteId: data.websiteId, id: record.id }, { $set: { [field]: null } });
				await deleteFile(s, record[field].key, owner, record.id);
				await service.log(ctx, `${owner}.${field}_removed`, record.id, { label: String(record.name) });
			}
			return { [field]: null };
		},
	});
	const categoryImage = single('category', 'image');
	const brandLogo = single('brand', 'logo');

	return [
		defineRoute({
			method: 'POST',
			path: '/v1/catalog/uploads',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: upload,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/products/:id/media',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: attach,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/products/:id/media',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: arrange,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/products/:id/media',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: detach,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/categories/:id/image',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categoryImage.set,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/categories/:id/image',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: categoryImage.remove,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/brands/:id/logo',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brandLogo.set,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/brands/:id/logo',
			auth: 'server',
			feature: 'catalog',
			rateLimit: STAFF_LIMITS,
			handler: brandLogo.remove,
		}),

		defineRoute({
			method: 'POST',
			path: '/v1/admin/catalog/uploads',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: upload,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/:id/media',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: attach,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/products/:id/media',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: arrange,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/products/:id/media',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: detach,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/categories/:id/image',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categoryImage.set,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/categories/:id/image',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: categoryImage.remove,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/brands/:id/logo',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brandLogo.set,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/brands/:id/logo',
			auth: 'ticket',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: brandLogo.remove,
		}),
	];
};
