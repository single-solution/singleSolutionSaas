/**
 * Digital goods (PLAN 0.8.8: download/licence after payment): the merchant adds and removes license keys and files of
 * a digital product whose item type has them (`licenceKeys`, `downloads`; server routes and the matching admin-widget
 * routes, permission `catalog.edit`). A removal takes them from new buyers only: a key given to an order stays with
 * it, and a file removed while orders have the product is kept (`retired`) for the orders placed before. When an
 * order is paid its digital lines get license keys (one per unit, each key given once); the shopper downloads the
 * files of a paid order through 5-minute signed links, counted per order line up to the download limit.
 * @module
 */
import { problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { productTypes } from '../adapters/catalog-store.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import {
	DOWNLOAD_SECONDS,
	MAX_FILE_BYTES,
	canDownload,
	checkLicenceKeys,
	downloadLimitOf,
	fileKey,
	fileNameOf,
	filesOfOrder,
	safeFileName,
} from '../core/digital.js';
import { elementsOf } from '../core/item-types.js';
import { ID_PREFIX } from '../core/model.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */

/** At most this many files per product. */
const MAX_FILES = 20;
/** A signed upload lasts this long. */
const UPLOAD_SECONDS = 900;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createDigital = (product, service) => {
	/**
	 * A digital product whose item type has the part (`licenceKeys` or `downloads`).
	 * @param {Site} s @param {string} id @param {'licenceKeys' | 'downloads'} part
	 */
	const digitalProduct = async (s, id, part) => {
		const data = await s.data();
		const found = await createOrdersStore(data).product(id);
		if (!found) throw problem('not_found', 'There is no such product.');
		if (found.kind !== 'digital') throw service.invalid('id', 'Only digital products have license keys and files.');
		const type = /** @type {import('../core/item-types.js').ItemType} */ (
			(await productTypes(data, [found], await s.list('item_types'))).get(found.id)
		);
		if (!elementsOf(type, s.has)[part])
			throw service.invalid(
				'id',
				part === 'licenceKeys' ? 'Its item type has no license keys.' : 'Its item type has no downloads.',
			);
		return found;
	};

	/** Add license keys to a product (`{ keys }`). @param {any} ctx */
	const addLicences = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkLicenceKeys(ctx.body?.keys);
		if (!checked.ok) throw service.invalid('keys', checked.message);
		const item = await digitalProduct(s, String(ctx.params.id), 'licenceKeys');
		const store = createOrdersStore(await s.data());
		const added = await store.addLicences(
			item.id,
			checked.value.map((key) => ({ id: createId(ID_PREFIX.licence), key })),
		);
		await service.log(ctx, 'product.licences_added', item.id, { label: item.name, detail: `${added} license key(s) added` });
		return { added, available: await store.countLicences(item.id) };
	};

	/** A signed upload of a file for a product (`{ name, type, size }`); the file is listed on the product. @param {any} ctx */
	const addFile = async (ctx) => {
		const s = await service.site(ctx);
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const name = safeFileName(body.name);
		if (!name) throw service.invalid('name', 'name is the file name (letters, digits, dot, dash).');
		if (typeof body.type !== 'string' || !MEDIA_TYPE.test(body.type)) throw service.invalid('type', 'type is a media type.');
		if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_FILE_BYTES)
			throw service.invalid('size', 'size is the file size in bytes (at most 5 GB).');
		const item = await digitalProduct(s, String(ctx.params.id), 'downloads');
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Connect storage in the product dashboard first.');
		const key = fileKey(item.id, name);
		const digital = /** @type {NonNullable<ProductRecord['digital']>} */ (item.digital);
		const files = digital.files.filter((file) => file.key !== key);
		if (files.length >= MAX_FILES) throw service.invalid('name', `A product has at most ${MAX_FILES} files.`);
		const signed = storage.presignPut({ key, contentType: body.type, contentLength: body.size, expiresIn: UPLOAD_SECONDS });
		const file = { key, type: body.type, size: body.size, alt: name };
		// the same name is the same storage key: a removed file of that name is the product's file again, for everyone
		await createOrdersStore(await s.data()).setDigital(item.id, {
			...digital,
			files: [...files, file],
			retired: digital.retired.filter((old) => old.key !== key),
		});
		await service.log(ctx, 'product.file_added', item.id, { label: item.name, detail: `File ${name}` });
		return {
			file: { name, type: file.type, size: file.size },
			upload: { method: signed.method, url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt },
		};
	};

	/**
	 * DELETE /v1/products/:id/files/:name: the file goes from the product. While orders have the product it is kept
	 * (`retired`) for the orders placed before now, so what they bought stays downloadable; else it is dropped.
	 * @param {any} ctx
	 */
	const removeFile = async (ctx) => {
		const s = await service.site(ctx);
		const item = await digitalProduct(s, String(ctx.params.id), 'downloads');
		const digital = /** @type {NonNullable<ProductRecord['digital']>} */ (item.digital);
		const name = String(ctx.params.name);
		const file = digital.files.find((entry) => fileNameOf(entry.key) === name);
		if (!file) throw problem('not_found', 'The product has no such file.');
		const store = createOrdersStore(await s.data());
		const keptForOrders = await store.productOrdered(item.id);
		const files = digital.files.filter((entry) => entry !== file);
		await store.setDigital(item.id, {
			...digital,
			files,
			retired: keptForOrders ? [...digital.retired, { ...file, removedAt: new Date(product.now()) }] : digital.retired,
		});
		await service.log(ctx, 'product.file_removed', item.id, {
			label: item.name,
			detail: keptForOrders ? `File ${name} (kept for earlier orders)` : `File ${name}`,
		});
		return {
			files: files.map((entry) => ({ name: fileNameOf(entry.key), type: entry.type, size: entry.size })),
			keptForOrders,
		};
	};

	/**
	 * POST /v1/products/:id/licences/remove `{ keys }`: the keys no order was given go; a key given to an order stays
	 * with it (counted as `given`).
	 * @param {any} ctx
	 */
	const removeLicences = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkLicenceKeys(ctx.body?.keys);
		if (!checked.ok) throw service.invalid('keys', checked.message);
		const item = await digitalProduct(s, String(ctx.params.id), 'licenceKeys');
		const store = createOrdersStore(await s.data());
		const { removed, given } = await store.removeLicences(item.id, checked.value);
		await service.log(ctx, 'product.licences_removed', item.id, {
			label: item.name,
			detail: `${removed} license key(s) removed`,
		});
		return { removed, given, available: await store.countLicences(item.id) };
	};

	/**
	 * Give the digital lines of a paid order their license keys (lines that still miss some). Runs on `order.paid`.
	 * @param {Site} s
	 * @param {OrderRecord} order
	 */
	const giveLicences = async (s, order) => {
		const lines = order.lines.filter((line) => line.kind === 'digital' && line.licences.length < line.quantity);
		if (lines.length === 0) return;
		const store = createOrdersStore(await s.data());
		const products = await store.products(lines.map((line) => line.productId));
		for (const line of lines) {
			if (!products.get(line.productId)?.digital?.licenceKeys) continue;
			const ids = await store.assignLicences({
				productId: line.productId,
				orderId: order.id,
				lineId: line.id,
				count: line.quantity - line.licences.length,
			});
			await store.addLineLicences(order.id, line.id, ids);
		}
	};

	/**
	 * The downloads and license keys of an order's digital lines, by line id (paid orders only).
	 * @param {Site} s
	 * @param {OrderRecord} order
	 * @returns {Promise<Map<string, { files: Array<{ file: string, name: string, type: string, size: number }>,
	 *   downloadsLeft: number | null, licenceKeys: string[] }>>}
	 */
	const linesOf = async (s, order) => {
		/** @type {Map<string, { files: Array<{ file: string, name: string, type: string, size: number }>, downloadsLeft: number | null, licenceKeys: string[] }>} */
		const out = new Map();
		const lines = order.lines.filter((line) => line.kind === 'digital');
		if (lines.length === 0 || !['paid', 'partially_refunded'].includes(order.payment.state)) return out;
		const store = createOrdersStore(await s.data());
		const products = await store.products(lines.map((line) => line.productId));
		const keys = await store.licenceKeys(lines.flatMap((line) => line.licences));
		const { downloadLimit } = await s.values('digital_goods');
		for (const line of lines) {
			const item = products.get(line.productId);
			const limit = item ? downloadLimitOf(item, downloadLimit) : 0;
			const used = Number(/** @type {any} */ (line).downloads ?? 0);
			out.set(line.id, {
				files: (item?.digital ? filesOfOrder(item.digital, order.placedAt) : []).map((file) => ({
					file: fileNameOf(file.key),
					name: file.alt || fileNameOf(file.key),
					type: file.type,
					size: file.size,
				})),
				downloadsLeft: limit > 0 ? Math.max(0, limit - used) : null,
				licenceKeys: line.licences.map((id) => keys.get(id)).filter((key) => key !== undefined),
			});
		}
		return out;
	};

	/**
	 * A 5-minute signed link to one file of a paid order line, counted against the download limit.
	 * @param {Site} s
	 * @param {OrderRecord} order
	 * @param {string} lineId
	 * @param {string} name the file name
	 */
	const download = async (s, order, lineId, name) => {
		const line = order.lines.find((entry) => entry.id === lineId && entry.kind === 'digital');
		if (!line) throw problem('not_found', 'There is no such download.');
		const store = createOrdersStore(await s.data());
		const item = await store.product(line.productId);
		const file = item?.digital
			? filesOfOrder(item.digital, order.placedAt).find((entry) => fileNameOf(entry.key) === name)
			: undefined;
		if (!item || !file) throw problem('not_found', 'There is no such download.');
		const { downloadLimit } = await s.values('digital_goods');
		const limit = downloadLimitOf(item, downloadLimit);
		const allowed = canDownload({
			paymentState: order.payment.state,
			downloads: Number(/** @type {any} */ (line).downloads),
			limit,
		});
		if (!allowed.ok)
			throw problem(
				'download_not_allowed',
				allowed.reason === 'not_paid'
					? 'Downloads open once the order is paid.'
					: 'This file was downloaded as often as allowed.',
			);
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Downloads are not available right now.');
		if (!(await store.countDownload(order.id, line.id, limit)))
			throw problem('download_not_allowed', 'This file was downloaded as often as allowed.');
		const signed = storage.presignGet({ key: file.key, expiresIn: DOWNLOAD_SECONDS, downloadName: name });
		return { url: signed.url, expiresAt: signed.expiresAt };
	};

	return Object.freeze({ addLicences, removeLicences, addFile, removeFile, giveLicences, linesOf, download });
};

/** @typedef {ReturnType<typeof createDigital>} Digital */
