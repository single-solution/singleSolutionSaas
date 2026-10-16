/**
 * Store details (the `store_details` feature): the public read for a website's header, footer and contact page
 * (`GET /v1/shop/store`), the business.json a headless website serves at `/.well-known/business.json`
 * (`GET /v1/shop/store/business-json`), and the logo and icon in the merchant's own storage, uploaded like product
 * images (a short presigned upload, then the file is checked in the bucket and kept in the record). The record is the
 * `store_details` list: the kit's `GET|PUT /v1/lists/store_details` and the dashboard's list routes read and save all
 * of it; the routes here only add the two files, which the dashboard editor uses too (setup only: no business data).
 * @module
 */
import { createId } from '@ss/contracts';
import { defineRoute, problem } from '@ss/app-kit';
import { IMAGE_TYPES } from '../core/catalog-content.js';
import { STORE_FILES, STORE_FOLDER, STORE_LIMITS, businessJsonOf, publicStoreDetails } from '../core/store-details.js';
import { refuse } from './catalog-common.js';
import { createMedia } from './catalog-media.js';
import { conditional } from './http-cache.js';
import { SERVER_LIMITS, UPLOAD_SECONDS, VISITOR_LIMITS, bodyOf } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/store-details.js').StoreDetails} StoreDetails */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createStoreDetails = (product, service) => {
	const media = createMedia(product);

	/** @param {Site} s @returns {Promise<StoreDetails>} */
	const detailsOf = async (s) => /** @type {StoreDetails} */ (/** @type {unknown} */ (await s.list('store_details')));

	/** The public address of a stored file that never changes (a search engine or a shopping catalog keeps it). @param {Site} s @param {{ key: string } | null} file */
	const urlOf = async (s, file) => (file ? await media.stableUrl(s, file.key) : null);

	/** GET /v1/shop/store: the public record. @param {any} ctx */
	const read = async (ctx) => {
		const s = await service.site(ctx);
		const [details, business] = await Promise.all([detailsOf(s), s.business()]);
		return publicStoreDetails(details, {
			logoUrl: await urlOf(s, details.logo),
			iconUrl: await urlOf(s, details.icon),
			businessName: String(business.name ?? ''),
		});
	};

	/** GET /v1/shop/store/business-json: the website's business.json made from the record. @param {any} ctx */
	const businessJson = async (ctx) => {
		const s = await service.site(ctx);
		const [details, business] = await Promise.all([detailsOf(s), s.business()]);
		const made = businessJsonOf(details, {
			logoUrl: await urlOf(s, details.logo),
			currency: s.currency,
			currencies: Array.isArray(business.currencies) && business.currencies.length > 0 ? business.currencies : [s.currency],
			businessName: String(business.name ?? ''),
			timeZone: String(business.timeZone ?? ''),
			language: String(business.language ?? ''),
			country: String(business.country ?? ''),
		});
		if (!made.ok) throw problem('conflict', 'Give the store a name (Store details) before its business.json can be made.');
		return made.value;
	};

	/** The two files with their addresses. @param {Site} s */
	const filesOf = async (s) => {
		const details = await detailsOf(s);
		/** @param {StoreDetails['logo']} file */
		const view = async (file) =>
			file ? { key: file.key, type: file.type, size: file.size, alt: file.alt, url: await media.mediaUrl(s, file.key) } : null;
		return { logo: await view(details.logo), icon: await view(details.icon) };
	};

	/**
	 * The file named in the path (`logo` or `icon`), or 404.
	 * @param {any} ctx @returns {'logo' | 'icon'}
	 */
	const fileName = (ctx) => {
		const name = String(ctx.params.file);
		if (!STORE_FILES.includes(name)) throw problem('not_found', 'The store has a logo and an icon.');
		return /** @type {'logo' | 'icon'} */ (name);
	};

	/** POST …/uploads `{ for: 'logo' | 'icon', type, size }` → a presigned upload (JPEG, PNG, WebP or AVIF). @param {any} ctx */
	const upload = async (ctx) => {
		const body = bodyOf(ctx);
		if (!STORE_FILES.includes(String(body.for))) throw refuse([{ path: '/for', message: 'Upload the logo or the icon.' }]);
		const type = String(body.type);
		const extension = /** @type {Record<string, string>} */ (IMAGE_TYPES)[type];
		if (!extension) throw refuse([{ path: '/type', message: 'Images are JPEG, PNG, WebP or AVIF.' }]);
		const s = await service.site(ctx);
		const limit = Math.min(Number((await s.values('catalog')).imageMaxBytes), STORE_LIMITS.file);
		if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > limit)
			throw refuse([{ path: '/size', message: `An image has at most ${limit} bytes.` }]);
		const storage = await service.storage(s);
		const key = `${STORE_FOLDER}${body.for}-${createId('img').slice(-10).toLowerCase()}.${extension}`;
		const signed = storage.presignPut({ key, contentType: type, contentLength: body.size, expiresIn: UPLOAD_SECONDS });
		return { key, upload: { method: signed.method, url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt } };
	};

	/** Delete a file of the store from the bucket (only one under the store's folder). @param {Site} s @param {string} key */
	const deleteFile = async (s, key) => {
		if (!key.startsWith(STORE_FOLDER)) return;
		const storage = await product.connections.storage(s.websiteId);
		if (storage) await storage.deleteObject({ key }).catch(() => null);
	};

	/** Save the details with a file set or removed, through the list's own check and save. @param {any} ctx @param {'logo' | 'icon'} name @param {StoreDetails['logo']} file */
	const keep = async (ctx, name, file) => {
		const s = await service.site(ctx);
		const details = await detailsOf(s);
		const saved = await product.lists.save(s.websiteId, 'store_details', { ...details, [name]: file });
		if (!saved.ok)
			throw refuse(
				saved.errors.map((error) => ({ path: `/${name}`, message: typeof error === 'string' ? error : error.message })),
			);
		return { s, before: details[name] };
	};

	/** PUT …/logo and …/icon `{ key, alt }`: the uploaded file is checked in the bucket and kept. @param {any} ctx */
	const attach = async (ctx) => {
		const name = fileName(ctx);
		const body = bodyOf(ctx);
		const s = await service.site(ctx);
		const storage = await service.storage(s);
		const key = typeof body.key === 'string' ? body.key : '';
		if (!key.startsWith(`${STORE_FOLDER}${name}-`) || key.includes('..'))
			throw refuse([{ path: '/key', message: `Give the key of the upload made for the ${name}.` }]);
		const alt = body.alt === undefined ? '' : String(body.alt).trim();
		if (alt.length > STORE_LIMITS.alt)
			throw refuse([{ path: '/alt', message: `Alternative text has at most ${STORE_LIMITS.alt} characters.` }]);
		const head = await storage.headObject({ key }).catch(() => {
			throw problem('upstream_error', 'Your storage cannot be reached right now.');
		});
		if (!head.exists) throw refuse([{ path: '/key', message: 'The file has not been uploaded.' }]);
		const type = String(head.contentType ?? '')
			.replace(/;.*$/, '')
			.trim();
		const limit = Math.min(Number((await s.values('catalog')).imageMaxBytes), STORE_LIMITS.file);
		if (!Object.hasOwn(IMAGE_TYPES, type) || head.size > limit) {
			await storage.deleteObject({ key }).catch(() => null);
			throw refuse([{ path: '/key', message: 'The file is not an image of an allowed type and size.' }]);
		}
		const { before } = await keep(ctx, name, { key, type, size: head.size, alt });
		if (before && before.key !== key) await deleteFile(s, before.key);
		await service.log(ctx, `store_details.${name}_set`, name, { label: name === 'logo' ? 'Logo' : 'Icon' });
		return { [name]: (await filesOf(s))[name] };
	};

	/** DELETE …/logo and …/icon. @param {any} ctx */
	const detach = async (ctx) => {
		const name = fileName(ctx);
		const { s, before } = await keep(ctx, name, null);
		if (before) {
			await deleteFile(s, before.key);
			await service.log(ctx, `store_details.${name}_removed`, name, { label: name === 'logo' ? 'Logo' : 'Icon' });
		}
		return { [name]: null };
	};

	/** GET …/files: the logo and icon with their addresses (the dashboard editor shows them). @param {any} ctx */
	const files = async (ctx) => filesOf(await service.site(ctx));

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/shop/store',
				auth: 'browser',
				feature: 'store_details',
				rateLimit: VISITOR_LIMITS,
				handler: conditional(read, service.now),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/store/business-json',
				auth: 'browser',
				feature: 'store_details',
				rateLimit: VISITOR_LIMITS,
				handler: conditional(businessJson, service.now),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/store-details/files',
				auth: 'server',
				feature: 'store_details',
				rateLimit: SERVER_LIMITS,
				handler: files,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/store-details/uploads',
				auth: 'server',
				feature: 'store_details',
				rateLimit: SERVER_LIMITS,
				handler: upload,
			}),
			defineRoute({
				method: 'PUT',
				path: '/v1/store-details/:file',
				auth: 'server',
				feature: 'store_details',
				rateLimit: SERVER_LIMITS,
				handler: attach,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/store-details/:file',
				auth: 'server',
				feature: 'store_details',
				rateLimit: SERVER_LIMITS,
				handler: detach,
			}),
			// the dashboard editor (setup only: the two files, nothing of the shop's business data)
			defineRoute({
				method: 'GET',
				path: '/v1/dashboard/websites/:websiteId/store-details/files',
				auth: 'dashboard',
				handler: files,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/dashboard/websites/:websiteId/store-details/uploads',
				auth: 'dashboard',
				handler: upload,
			}),
			defineRoute({
				method: 'PUT',
				path: '/v1/dashboard/websites/:websiteId/store-details/:file',
				auth: 'dashboard',
				handler: attach,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/dashboard/websites/:websiteId/store-details/:file',
				auth: 'dashboard',
				handler: detach,
			}),
		],
	};
};
