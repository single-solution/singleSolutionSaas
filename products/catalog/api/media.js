/**
 * Media service: references (URL or storage key) on items, and — with the optional `media_uploads` element — presigned
 * uploads straight to the merchant's own bucket (the storage connector signs `content-type` and `content-length`, so
 * the bucket enforces both), an existence check before a key is attached, and short signed view links for keys when
 * no public storage base URL is set. The catalog never receives file bytes.
 */
import { validateMedia } from '../core/media.js';
import { isId, isObject, issue } from '../core/text.js';
import { fail, invalid, mutateItem, updatedEntry } from './catalog.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */

const EXTENSIONS = Object.freeze({
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/gif': 'gif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
});

/**
 * @param {Deps} deps
 */
export const createMediaService = (deps) => {
	/** @param {Site} site */
	const uploadsOn = (site) => site.settings.enabled('media_uploads');

	/**
	 * Whether a storage key exists in the merchant's bucket (only checked when uploads are on).
	 * @param {Site} site
	 * @param {string} key
	 */
	const keyExists = async (site, key) => {
		if (!uploadsOn(site)) return true;
		try {
			const storage = await deps.storage(site.websiteId);
			return (await storage.headObject({ key })).exists === true;
		} catch {
			return false;
		}
	};

	/**
	 * Attach media to an item (`POST /v1/media`, id derived from the Idempotency-Key).
	 * @param {Site} site
	 * @param {unknown} body `{ itemId, url | key, kind?, alt?, role?, width?, height?, variantIds?, position? }`
	 * @param {{ key: string }} options
	 */
	const add = async (site, body, { key }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const { itemId, ...fields } = /** @type {Record<string, any>} */ (body);
		if (!isId(itemId)) return invalid([issue('/itemId', 'required')]);
		const result = validateMedia(fields, { kinds: site.settings.media.kinds, allowedHosts: site.settings.media.allowed_hosts });
		if (!result.value) return invalid(result.problems);
		const value = result.value;
		if (value.key && !(await keyExists(site, value.key))) return fail('media_missing', 'The object is not in your storage.');
		const id = `med_${deps.stableId(`${site.websiteId}|media|${key}`)}`;
		return mutateItem(
			deps,
			site,
			() => site.repos.items.get(itemId),
			(current) => {
				if (current.deletedAt) return fail('not_found', 'No such item.');
				const media = current.media ?? [];
				if (media.some((/** @type {any} */ m) => m.id === id)) return null;
				if (media.length >= site.settings.media.max_media_per_item)
					return fail('limit_reached', `An item may have ${site.settings.media.max_media_per_item} media.`);
				const variantIds = new Set((current.variants ?? []).map((/** @type {any} */ v) => v.id));
				if (!value.variantIds.every((v) => variantIds.has(v))) return invalid([issue('/variantIds', 'variant_unknown')]);
				return {
					next: { ...current, media: [...media, { ...value, id, position: value.position || media.length }] },
					entries: updatedEntry(current, ['media']),
					result: id,
				};
			},
		);
	};

	/**
	 * Patch a media reference.
	 * @param {Site} site
	 * @param {string} mediaId
	 * @param {unknown} body
	 */
	const update = async (site, mediaId, body) => {
		const item = await site.repos.items.byMedia(mediaId);
		if (!item) return fail('not_found', 'No such media.');
		const currentMedia = item.media.find((/** @type {any} */ m) => m.id === mediaId);
		const result = validateMedia(body, {
			current: currentMedia,
			kinds: site.settings.media.kinds,
			allowedHosts: site.settings.media.allowed_hosts,
		});
		if (!result.value) return invalid(result.problems);
		const value = result.value;
		if (value.key && value.key !== currentMedia.key && !(await keyExists(site, value.key)))
			return fail('media_missing', 'The object is not in your storage.');
		return mutateItem(
			deps,
			site,
			() => site.repos.items.byMedia(mediaId),
			(current) => {
				const variantIds = new Set((current.variants ?? []).map((/** @type {any} */ v) => v.id));
				if (!value.variantIds.every((v) => variantIds.has(v))) return invalid([issue('/variantIds', 'variant_unknown')]);
				const media = current.media.map((/** @type {any} */ m) => (m.id === mediaId ? { ...m, ...value } : m));
				return JSON.stringify(media) === JSON.stringify(current.media)
					? null
					: { next: { ...current, media }, entries: updatedEntry(current, ['media']) };
			},
		);
	};

	/**
	 * Detach media (the file itself stays where it is).
	 * @param {Site} site
	 * @param {string} mediaId
	 */
	const remove = async (site, mediaId) =>
		mutateItem(
			deps,
			site,
			() => site.repos.items.byMedia(mediaId),
			(current) => ({
				next: {
					...current,
					media: current.media.filter((/** @type {any} */ m) => m.id !== mediaId),
					variants: (current.variants ?? []).map((/** @type {any} */ v) => ({
						...v,
						mediaIds: v.mediaIds.filter((/** @type {string} */ id) => id !== mediaId),
					})),
				},
				entries: updatedEntry(current, ['media']),
			}),
		);

	/**
	 * Reorder an item's media (`POST /v1/media:reorder { itemId, ids }`).
	 * @param {Site} site
	 * @param {unknown} body
	 */
	const reorder = async (site, body) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const { itemId, ids } = /** @type {Record<string, any>} */ (body);
		if (!isId(itemId) || !Array.isArray(ids) || !ids.every(isId)) return invalid([issue('/ids', 'ids_invalid')]);
		return mutateItem(
			deps,
			site,
			() => site.repos.items.get(itemId),
			(current) => {
				const media = current.media ?? [];
				if (ids.length !== media.length || !media.every((/** @type {any} */ m) => ids.includes(m.id)))
					return invalid([issue('/ids', 'ids_mismatch')]);
				const next = media.map((/** @type {any} */ m) => ({ ...m, position: ids.indexOf(m.id) }));
				return JSON.stringify(next) === JSON.stringify(media)
					? null
					: { next: { ...current, media: next }, entries: updatedEntry(current, ['media']) };
			},
		);
	};

	/**
	 * A presigned upload into the merchant's bucket (`POST /v1/media-uploads`).
	 * @param {Site} site
	 * @param {unknown} body `{ contentType, contentLength, itemId? }`
	 */
	const presign = async (site, body) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const { contentType, contentLength, itemId } = /** @type {Record<string, any>} */ (body);
		const { uploads } = site.settings;
		/** @type {Array<{ path: string, code: string }>} */
		const problems = [];
		if (typeof contentType !== 'string' || !uploads.content_types.includes(contentType))
			problems.push(issue('/contentType', 'type_not_allowed'));
		if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > uploads.max_upload_bytes)
			problems.push(issue('/contentLength', 'size_invalid'));
		if (itemId !== undefined && !isId(itemId)) problems.push(issue('/itemId', 'id_invalid'));
		if (problems.length > 0) return invalid(problems);
		const extension = /** @type {Record<string, string>} */ (EXTENSIONS)[contentType] ?? 'bin';
		const key = `catalog/${itemId ?? 'unassigned'}/${deps.newId('upl')}.${extension}`;
		try {
			const storage = await deps.storage(site.websiteId);
			const signed = await storage.presignPut({ key, contentType, contentLength, expiresIn: uploads.upload_ttl_seconds });
			return {
				ok: /** @type {const} */ (true),
				upload: {
					key: signed.key,
					method: signed.method,
					url: signed.url,
					headers: signed.headers,
					expiresAt: signed.expiresAt,
				},
			};
		} catch {
			return fail('storage_unavailable', 'The storage connector is not available.');
		}
	};

	/**
	 * Signed view links of the storage keys of some items (when keys have no public base URL and uploads are on).
	 * @param {Site} site
	 * @param {ReadonlyArray<Record<string, any>>} items
	 * @returns {Promise<Map<string, string> | undefined>}
	 */
	const signedLinks = async (site, items) => {
		if (site.settings.media.storage_base_url || !uploadsOn(site)) return undefined;
		const keys = [
			...new Set(items.flatMap((item) => (item.media ?? []).map((/** @type {any} */ m) => m.key).filter(Boolean))),
		].slice(0, 200);
		if (keys.length === 0) return undefined;
		try {
			const storage = await deps.storage(site.websiteId);
			const links = await Promise.all(
				keys.map(async (key) => [
					key,
					(await storage.presignGet({ key, expiresIn: site.settings.uploads.view_ttl_seconds })).url,
				]),
			);
			return new Map(/** @type {Array<[string, string]>} */ (links));
		} catch {
			return undefined;
		}
	};

	return Object.freeze({ add, update, remove, reorder, presign, signedLinks });
};

/** @typedef {ReturnType<typeof createMediaService>} MediaService */
