/**
 * Feeds service: the feeds configured in the settings (`feeds.feeds`), their tokened public URLs, and the generated
 * body for one feed. Feeds hold public data only (public items, public custom fields; never cost). Bodies are served
 * with `Cache-Control: public` for `feeds.cache_seconds`, a strong ETag, and kept in a small in-process cache for the
 * same lifetime so CDNs and repeated crawler hits cost one generation.
 */
import { CONTENT_TYPES, feedRows, mappingOf, renderFeed, sourceValid } from '../core/feeds.js';
import { visibleCollectionIds, withDescendants } from '../core/collections.js';
import { etagOf } from '../adapters/tokens.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */

/** Feed bodies kept in memory. */
const CACHE_ENTRIES = 50;

/**
 * @param {Deps} deps
 * @param {{ items: import('./items.js').ItemsService, baseUrl: () => string }} options
 */
export const createFeedsService = (deps, { items, baseUrl }) => {
	/** @type {Map<string, { body: string, etag: string, contentType: string, expires: number, rows: number, truncated: boolean }>} */
	const cache = new Map();

	/**
	 * Configured feeds with their URLs (sk_ / dashboard only: the URL is the credential).
	 * @param {Site} site
	 */
	const list = (site) =>
		site.settings.feeds.feeds.map((/** @type {any} */ feed) => {
			const token = deps.tokens.issue({
				websiteId: site.websiteId,
				feedKey: feed.key,
				version: site.settings.feeds.token_version,
			});
			const invalidSources = mappingOf(feed)
				.filter((m) => !sourceValid(m.source))
				.map((m) => m.source);
			return {
				key: feed.key,
				name: feed.name,
				format: feed.format,
				url: `${baseUrl().replace(/\/+$/, '')}/feeds/${token}`,
				mapping: mappingOf(feed),
				invalidSources,
				collectionIds: feed.collection_ids ?? [],
				brandIds: feed.brand_ids ?? [],
				includeOutOfStock: feed.include_out_of_stock !== false,
			};
		});

	/**
	 * The public items in a feed's scope, in creation order, bounded.
	 * @param {Site} site
	 * @param {Record<string, any>} feed
	 * @param {number} limit
	 */
	const scopedItems = async (site, feed, limit) => {
		/** @type {Record<string, unknown>} */
		const filter = items.publicFilter(site);
		const collections = await site.repos.collections.list({ limit: 10_000 });
		if ((feed.collection_ids ?? []).length > 0) {
			const visible = visibleCollectionIds(collections);
			filter.collectionIds = {
				$in: feed.collection_ids
					.filter((/** @type {string} */ id) => visible.has(id))
					.flatMap((/** @type {string} */ id) => withDescendants(collections, id)),
			};
		}
		if ((feed.brand_ids ?? []).length > 0) filter.brandId = { $in: feed.brand_ids };
		/** @type {Array<Record<string, any>>} */
		const out = [];
		/** @type {unknown} */
		let after = null;
		while (out.length < limit) {
			const page = await site.repos.items.list({
				filter: after ? { ...filter, $and: [.../** @type {any[]} */ (filter.$and ?? []), { id: { $gt: after } }] } : filter,
				sort: { id: 1 },
				fetchLimit: Math.min(500, limit - out.length),
			});
			out.push(...page);
			if (page.length < 500) break;
			after = page.at(-1)?.id;
		}
		return { items: out, collections };
	};

	/**
	 * Generate (or serve from cache) one feed.
	 * @param {Site} site
	 * @param {string} feedKey
	 * @returns {Promise<{ body: string, etag: string, contentType: string, maxAge: number, rows: number, truncated: boolean } | null>}
	 */
	const render = async (site, feedKey) => {
		const settings = site.settings.feeds;
		const feed = settings.feeds.find((/** @type {any} */ f) => f.key === feedKey);
		if (!feed) return null;
		const cacheKey = `${site.websiteId}|${feedKey}|${settings.token_version}|${JSON.stringify(feed)}`;
		const hit = cache.get(cacheKey);
		const now = deps.now();
		if (hit && hit.expires > now) return { ...hit, maxAge: Math.max(1, Math.floor((hit.expires - now) / 1000)) };
		const maxRows = settings.max_items_per_feed;
		const { items: list, collections } = await scopedItems(site, feed, maxRows);
		const brands = new Map((await site.repos.brands.list({ limit: 10_000 })).map((/** @type {any} */ b) => [b.id, b]));
		const visible = visibleCollectionIds(collections);
		const byId = new Map(collections.map((/** @type {any} */ c) => [c.id, c]));
		const { rows, truncated } = feedRows(list, feed, {
			domain: site.settings.domain,
			urlTemplate: site.settings.items.item_url_template,
			stock: site.settings.stock,
			media: site.settings.media,
			currencyOf: (item) => site.settings.currencyOf(item),
			exponentOf: site.settings.exponentOf,
			brandName: (id) => {
				const brand = id ? brands.get(id) : null;
				return brand && brand.visible !== false ? brand.name : null;
			},
			productType: (item) => {
				const first = (item.collectionIds ?? []).find((/** @type {string} */ id) => visible.has(id));
				const collection = first ? byId.get(first) : null;
				if (!collection) return null;
				return [
					...collection.ancestors.map((/** @type {string} */ a) => byId.get(a)?.title).filter(Boolean),
					collection.title,
				].join(' > ');
			},
			condition: { source: settings.condition_source, map: settings.condition_map, fallback: settings.default_condition },
			publicCustom: site.settings.items.custom_fields
				.filter((/** @type {any} */ f) => f.public)
				.map((/** @type {any} */ f) => f.key),
			maxRows,
		});
		const body = renderFeed(feed, rows, { domain: site.settings.domain, generatedAt: new Date(now).toISOString() });
		const entry = {
			body,
			etag: etagOf(body),
			contentType: /** @type {Record<string, string>} */ (CONTENT_TYPES)[feed.format] ?? CONTENT_TYPES.json,
			expires: now + settings.cache_seconds * 1000,
			rows: rows.length,
			truncated,
		};
		cache.set(cacheKey, entry);
		while (cache.size > CACHE_ENTRIES) cache.delete(/** @type {string} */ (cache.keys().next().value));
		return { ...entry, maxAge: settings.cache_seconds };
	};

	return Object.freeze({ list, render });
};

/** @typedef {ReturnType<typeof createFeedsService>} FeedsService */
