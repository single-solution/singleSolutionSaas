/**
 * Items service: create (with variants and media in one call), JSON Merge Patch updates, soft delete, reads and
 * listing for owners (`sk_`, dashboard) and shoppers (`pk_`), and the views. Writes validate in `core/`, check
 * references (brand scoping, collections, SKUs), keep the rollups and push the standard events through the outbox.
 */
import { validateItemAttributes } from '../core/attributes.js';
import { brandAllowed } from '../core/brands.js';
import { visibleCollectionIds, withDescendants } from '../core/collections.js';
import { EVENT_TYPES } from '../core/events.js';
import { changedFields, defaultVariantInput, isPublic, statusDef, validateItem } from '../core/items.js';
import { validateMedia } from '../core/media.js';
import { afterFilter, cursorKey, parseItemQuery, sortSpec } from '../core/query.js';
import { checkVariantSet, validateDimensions, validateVariant } from '../core/variants.js';
import { ownerItem, publicItem } from '../core/views.js';
import { isObject, issue } from '../core/text.js';
import { isDuplicateKey } from '../adapters/db.js';
import { attributesOf, entry, fail, flushItem, finalize, invalid, mutateItem, updatedEntry } from './catalog.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */
/** @typedef {import('./catalog.js').Failure} Failure */

/** Fields an item create or patch may carry (everything else is refused). */
const ITEM_KEYS = new Set([
	'title',
	'slug',
	'type',
	'status',
	'summary',
	'description',
	'brandId',
	'collectionIds',
	'attributes',
	'custom',
	'tags',
	'currency',
	'options',
	'optionPool',
	'seo',
	'translations',
	'publishAt',
	'unpublishAt',
	'externalId',
]);
const CREATE_ONLY = new Set([
	'variants',
	'media',
	'price',
	'compareAtPrice',
	'cost',
	'sku',
	'barcode',
	'quantity',
	'trackInventory',
	'backorder',
]);

/**
 * Option values of every variant-option attribute.
 * @param {readonly import('../core/attributes.js').Attribute[]} attributes
 */
export const optionPools = (attributes) =>
	new Map(attributes.filter((a) => a.variantOption).map((a) => [a.key, a.options.map((o) => o.value)]));

/**
 * The taxonomy an item write is checked against.
 * @param {Site} site
 */
export const taxonomyOf = async (site) => {
	const [collections, attributes] = await Promise.all([site.repos.collections.list({ limit: 10_000 }), attributesOf(site)]);
	return { collections, attributes };
};

/**
 * References of an item: the brand exists and allows the collections (scoping), the collections exist, a brand is set
 * when required.
 * @param {Site} site
 * @param {{ brandId: string | null, collectionIds: string[] }} fields
 * @param {ReadonlyArray<{ id: string, ancestors: string[] }>} collections
 * @returns {Promise<Array<{ path: string, code: string }>>}
 */
export const checkReferences = async (site, fields, collections) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const known = new Set(collections.map((c) => c.id));
	fields.collectionIds.forEach((id, index) => {
		if (!known.has(id)) problems.push(issue(`/collectionIds/${index}`, 'collection_unknown'));
	});
	if (fields.brandId === null) {
		if (site.settings.brands.require_brand && site.settings.enabled('brands')) problems.push(issue('/brandId', 'required'));
		return problems;
	}
	const brand = await site.repos.brands.get(fields.brandId);
	if (!brand) problems.push(issue('/brandId', 'brand_unknown'));
	else if (site.settings.brands.scoping && !brandAllowed(brand, fields.collectionIds, collections))
		problems.push(issue('/brandId', 'brand_out_of_scope'));
	return problems;
};

/**
 * SKUs already used by other items (when SKUs are unique across the catalog).
 * @param {Site} site
 * @param {string | null} itemId the item being written
 * @param {ReadonlyArray<Record<string, any>>} variants
 */
export const skuConflicts = async (site, itemId, variants) => {
	if (!site.settings.variants.unique_sku_across_items) return [];
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	for (const [index, variant] of variants.entries()) {
		if (!variant.sku) continue;
		const other = await site.repos.items.bySku(variant.sku);
		if (other && other.id !== itemId) problems.push(issue(`/variants/${index}/sku`, 'sku_taken'));
	}
	return problems;
};

/**
 * The view context of a site.
 * @param {Site} site
 * @param {{ attributes: readonly import('../core/attributes.js').Attribute[], brand?: any, item?: Record<string, any> | null,
 *   lang?: string | null, visibleCollections?: Set<string> | null, signed?: Map<string, string> }} input
 */
export const viewContext = (site, { attributes, brand = null, item = null, lang = null, visibleCollections = null, signed }) => ({
	items: site.settings.items,
	stock: site.settings.stock,
	media: site.settings.media,
	attributes,
	currency: site.settings.currencyOf(item),
	brand: brand ? { id: brand.id, slug: brand.slug, name: brand.name } : null,
	domain: site.settings.domain,
	lang: lang && site.settings.items.languages.includes(lang) ? lang : null,
	visibleCollections,
	...(signed ? { signed } : {}),
});

/**
 * @param {Deps} deps
 */
export const createItemsService = (deps) => {
	/**
	 * Owner view of a stored item.
	 * @param {Site} site
	 * @param {Record<string, any>} item
	 * @param {{ exposeCost: boolean, attributes?: import('../core/attributes.js').Attribute[], signed?: Map<string, string> }} options
	 */
	const owner = async (site, item, { exposeCost, attributes, signed }) => {
		const [defs, brand] = await Promise.all([
			attributes ?? attributesOf(site),
			item.brandId ? site.repos.brands.get(item.brandId) : null,
		]);
		return ownerItem(item, {
			...viewContext(site, { attributes: defs, brand, item, ...(signed ? { signed } : {}) }),
			exposeCost,
		});
	};

	/**
	 * Public views of stored items (brands and the visible collections loaded once).
	 * @param {Site} site
	 * @param {ReadonlyArray<Record<string, any>>} items
	 * @param {{ lang?: string | null, signed?: Map<string, string> }} [options]
	 */
	const publicViews = async (site, items, { lang = null, signed } = {}) => {
		const [attributes, collections] = await Promise.all([attributesOf(site), site.repos.collections.list({ limit: 10_000 })]);
		const brandIds = [...new Set(items.map((item) => item.brandId).filter(Boolean))];
		const brands = new Map(
			(await Promise.all(brandIds.map((id) => site.repos.brands.get(id)))).filter(Boolean).map((b) => [b.id, b]),
		);
		const visible = visibleCollectionIds(collections);
		return items.map((item) => {
			const brand = brands.get(item.brandId);
			return publicItem(
				item,
				viewContext(site, {
					attributes,
					brand: brand && brand.visible !== false ? brand : null,
					item,
					lang,
					visibleCollections: visible,
					...(signed ? { signed } : {}),
				}),
			);
		});
	};

	/**
	 * A free slug: the given one (taken = conflict) or the title's with a numeric suffix.
	 * @param {Site} site
	 * @param {string} slug
	 * @param {boolean} explicit
	 * @param {string | null} itemId
	 * @returns {Promise<string | null>} null when an explicit slug is taken
	 */
	const freeSlug = async (site, slug, explicit, itemId) => {
		for (let n = 1; n <= 50; n += 1) {
			const candidate = n === 1 ? slug : `${slug.slice(0, 110)}-${n}`;
			const other = await site.repos.items.bySlug(candidate);
			if (!other || other.id === itemId) return candidate;
			if (explicit) return null;
		}
		return `${slug.slice(0, 100)}-${deps.newId('s').slice(2, 12)}`;
	};

	/**
	 * Create an item. The id derives from the Idempotency-Key, so a retried create converges on the same item.
	 * @param {Site} site
	 * @param {unknown} body
	 * @param {{ key: string, actor: import('./catalog.js').Actor, exposeCost: boolean }} options
	 * @returns {Promise<{ ok: true, item: Record<string, any>, view: Record<string, any>, created: boolean } | Failure>}
	 */
	const create = async (site, body, { key, actor, exposeCost }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const input = /** @type {Record<string, any>} */ (body);
		const unknown = Object.keys(input).filter((name) => !ITEM_KEYS.has(name) && !CREATE_ONLY.has(name));
		if (unknown.length > 0) return invalid(unknown.map((name) => issue(`/${name}`, 'field_unknown')));
		const id = `itm_${deps.stableId(`${site.websiteId}|item|${key}`)}`;
		const existing = await site.repos.items.get(id);
		if (existing)
			return {
				ok: /** @type {const} */ (true),
				item: existing,
				view: await owner(site, existing, { exposeCost }),
				created: false,
			};
		const limit = site.settings.items.max_items;
		if ((await site.repos.items.count({ deletedAt: null })) >= limit)
			return fail('limit_reached', `This website may hold ${limit} items (items.max_items).`);
		const { collections, attributes } = await taxonomyOf(site);
		const fields = validateItem(input, {
			settings: site.settings.items,
			maxCollections: site.settings.collections.max_collections_per_item,
		});
		if (!fields.value) return invalid(fields.problems);
		const pools = optionPools(attributes);
		const dims = validateDimensions(input.options, input.optionPool, pools);
		const attrs = validateItemAttributes(attributes, input.attributes, {
			brandId: fields.value.brandId,
			collectionIds: fields.value.collectionIds,
		});
		const shorthand = defaultVariantInput(input);
		if (shorthand && input.variants !== undefined) return invalid([issue('/variants', 'variants_or_price')]);
		const variantInputs = shorthand ? [shorthand] : Array.isArray(input.variants) ? input.variants : [];
		if (input.variants !== undefined && !Array.isArray(input.variants)) return invalid([issue('/variants', 'array_required')]);
		/** @type {Array<{ path: string, code: string }>} */
		const problems = [...dims.problems, ...attrs.problems];
		const variants = variantInputs.map((raw, index) => {
			const result = validateVariant(raw, { path: `/variants/${index}` });
			problems.push(...result.problems);
			return result.value
				? {
						...result.value,
						id: `var_${deps.stableId(`${id}|variant|${index}`)}`,
						trackInventory: result.value.trackInventory,
						position: result.value.position || index,
						restockedAt: null,
					}
				: null;
		});
		const mediaInputs = input.media === undefined ? [] : input.media;
		if (!Array.isArray(mediaInputs) || mediaInputs.length > site.settings.media.max_media_per_item)
			problems.push(issue('/media', 'media_invalid'));
		const media = (Array.isArray(mediaInputs) ? mediaInputs : []).map((raw, index) => {
			const result = validateMedia(raw, { kinds: site.settings.media.kinds, allowedHosts: site.settings.media.allowed_hosts });
			problems.push(...result.problems.map((p) => issue(`/media/${index}${p.path}`, p.code)));
			return result.value
				? { ...result.value, id: `med_${deps.stableId(`${id}|media|${index}`)}`, position: result.value.position || index }
				: null;
		});
		if (problems.length > 0) return invalid(problems);
		const ready = /** @type {import('../core/variants.js').Variant[]} */ (variants);
		problems.push(
			...checkVariantSet(ready, {
				optionKeys: dims.options,
				optionPool: dims.optionPool,
				poolsOn: site.settings.variants.option_pools,
				attributeOptions: pools,
				uniqueness: site.settings.variants.uniqueness,
				maxVariants: site.settings.variants.max_variants_per_item,
			}),
			...(await checkReferences(site, fields.value, collections)),
			...(await skuConflicts(site, id, ready)),
		);
		if (problems.length > 0) return invalid(problems);
		const slug = await freeSlug(site, fields.value.slug, Object.hasOwn(input, 'slug'), id);
		if (slug === null) return fail('slug_taken', 'Another item uses this slug.');
		const now = deps.now();
		const doc = finalize(
			site,
			{
				id,
				...fields.value,
				slug,
				previousSlugs: [],
				attributes: attrs.value,
				options: dims.options,
				optionPool: dims.optionPool,
				variants: ready,
				media,
				deletedAt: null,
				createdAt: new Date(now),
				version: 0,
			},
			{ attributes, now },
		);
		const stored = { ...doc, outbox: [entry(EVENT_TYPES.created, `item.created:${id}`)], outboxAt: doc.updatedAt };
		try {
			await site.repos.items.insert(stored);
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
			const raced = await site.repos.items.get(id);
			if (raced)
				return {
					ok: /** @type {const} */ (true),
					item: raced,
					view: await owner(site, raced, { exposeCost, attributes }),
					created: false,
				};
			return fail('slug_taken', 'Another item uses this slug or external id.');
		}
		await flushItem(deps, site, stored);
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'item.created', target: { itemId: id } })
			.catch(() => undefined);
		return {
			ok: /** @type {const} */ (true),
			item: stored,
			view: await owner(site, stored, { exposeCost, attributes }),
			created: true,
		};
	};

	/**
	 * JSON Merge Patch of the item-level fields (variants and media have their own resources).
	 * @param {Site} site
	 * @param {string} id
	 * @param {unknown} body
	 * @param {{ actor: import('./catalog.js').Actor, exposeCost: boolean, expectedVersion?: number | null }} options
	 */
	const update = async (site, id, body, { actor, exposeCost, expectedVersion = null }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const input = /** @type {Record<string, any>} */ (body);
		const refused = Object.keys(input).filter((name) => !ITEM_KEYS.has(name));
		if (refused.length > 0)
			return invalid(refused.map((name) => issue(`/${name}`, CREATE_ONLY.has(name) ? 'use_sub_resource' : 'field_unknown')));
		const result = await mutateItem(
			deps,
			site,
			() => site.repos.items.get(id),
			async (current, attributes) => {
				if (current.deletedAt) return fail('not_found', 'No such item.');
				if (expectedVersion !== null && current.version !== expectedVersion)
					return fail('version_mismatch', 'The item changed since you read it.');
				const fields = validateItem(input, {
					settings: site.settings.items,
					current: /** @type {any} */ (current),
					maxCollections: site.settings.collections.max_collections_per_item,
				});
				if (!fields.value) return invalid(fields.problems);
				const pools = optionPools(attributes);
				const dims =
					Object.hasOwn(input, 'options') || Object.hasOwn(input, 'optionPool')
						? validateDimensions(
								input.options ?? current.options,
								Object.hasOwn(input, 'optionPool') ? input.optionPool : current.optionPool,
								pools,
							)
						: { problems: [], options: current.options ?? [], optionPool: current.optionPool ?? {} };
				const attrs = validateItemAttributes(attributes, input.attributes, {
					brandId: fields.value.brandId,
					collectionIds: fields.value.collectionIds,
					current: current.attributes ?? {},
					partial: true,
				});
				const collections = await site.repos.collections.list({ limit: 10_000 });
				const problems = [
					...dims.problems,
					...attrs.problems,
					...checkVariantSet(current.variants ?? [], {
						optionKeys: dims.options,
						optionPool: dims.optionPool,
						poolsOn: site.settings.variants.option_pools,
						attributeOptions: pools,
						uniqueness: site.settings.variants.uniqueness,
						maxVariants: Number.MAX_SAFE_INTEGER,
					}),
					...(Object.hasOwn(input, 'brandId') || Object.hasOwn(input, 'collectionIds')
						? await checkReferences(site, fields.value, collections)
						: []),
				];
				if (problems.length > 0) return invalid(problems);
				let slug = fields.value.slug;
				if (slug !== current.slug) {
					const free = await freeSlug(site, slug, true, id);
					if (free === null) return fail('slug_taken', 'Another item uses this slug.');
					slug = free;
				}
				const previousSlugs =
					slug !== current.slug
						? [
								current.slug,
								...(current.previousSlugs ?? []).filter((/** @type {string} */ s) => s !== slug && s !== current.slug),
							].slice(0, 20)
						: (current.previousSlugs ?? []);
				const next = {
					...current,
					...fields.value,
					slug,
					previousSlugs,
					attributes: attrs.value,
					options: dims.options,
					optionPool: dims.optionPool,
				};
				const changed = changedFields(current, next);
				if (changed.length === 0) return null;
				return { next, entries: updatedEntry(current, changed) };
			},
		);
		if (!result.ok) return result;
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'item.updated', target: { itemId: id } })
			.catch(() => undefined);
		return { ok: /** @type {const} */ (true), item: result.item, view: await owner(site, result.item, { exposeCost }) };
	};

	/**
	 * Soft delete (the item keeps its id and slug; `item.deleted@1` is published).
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ actor: import('./catalog.js').Actor, reason?: string }} options
	 */
	const remove = async (site, id, { actor, reason = 'deleted' }) => {
		const result = await mutateItem(
			deps,
			site,
			() => site.repos.items.get(id),
			(current) => {
				if (current.deletedAt) return null;
				return {
					next: { ...current, deletedAt: new Date(deps.now()) },
					entries: [entry(EVENT_TYPES.deleted, `item.deleted:${id}:${(current.version ?? 0) + 1}`, { itemId: id, reason })],
				};
			},
		);
		if (!result.ok) return result;
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'item.deleted', target: { itemId: id } })
			.catch(() => undefined);
		return { ok: /** @type {const} */ (true), item: result.item };
	};

	/**
	 * An item by id or slug (owners see every item; shoppers only public ones, and old slugs resolve to the item).
	 * @param {Site} site
	 * @param {string} ref
	 * @param {{ owner: boolean }} options
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const find = async (site, ref, { owner: isOwner }) => {
		const byId = ref.startsWith('itm_');
		const item = byId
			? await site.repos.items.get(ref)
			: ((await site.repos.items.bySlug(ref)) ?? (await site.repos.items.byPreviousSlug(ref)));
		if (!item) return null;
		if (isOwner) return item;
		return isPublic(item, {
			statuses: site.settings.items.statuses,
			now: deps.now(),
			scheduled: site.settings.items.scheduled_publish,
		})
			? item
			: null;
	};

	/**
	 * The database filter of public items.
	 * @param {Site} site
	 */
	const publicFilter = (site) => {
		const visible = site.settings.items.statuses.filter((s) => s.visible).map((s) => s.key);
		const now = new Date(deps.now()).toISOString();
		return {
			deletedAt: null,
			status: { $in: visible },
			...(site.settings.items.scheduled_publish
				? {
						$and: [
							{ $or: [{ publishAt: null }, { publishAt: { $lte: now } }] },
							{ $or: [{ unpublishAt: null }, { unpublishAt: { $gt: now } }] },
						],
					}
				: {}),
		};
	};

	/**
	 * A page of items.
	 * @param {Site} site
	 * @param {Record<string, string | undefined>} query
	 * @param {{ owner: boolean, after: unknown, fetchLimit: number, total?: boolean }} page with `query.page` (1-based),
	 *   offset pages of `fetchLimit - 1` items instead of the cursor; `total` also counts the matching items
	 * @returns {Promise<{ ok: true, items: Array<Record<string, any>>, spec: Array<[string, 1 | -1]>, sort: string,
	 *   where: Record<string, unknown>, page: number | null, total: number | null } | Failure>}
	 */
	const list = async (site, query, { owner: isOwner, after, fetchLimit, total = false }) => {
		const settings = site.settings.items;
		const parsed = parseItemQuery(query, {
			owner: isOwner,
			sorts: settings.sorts,
			defaultSort: settings.default_sort,
			statuses: settings.statuses.map((s) => s.key),
		});
		if (parsed.problems.length > 0) return invalid(parsed.problems);
		const { filter } = parsed;
		const spec = sortSpec(parsed.sort);
		const cursor = after === null ? null : afterFilter(spec, after);
		if (after !== null && !cursor) return fail('bad_request', 'The cursor does not match this sort.');
		/** @type {Record<string, unknown>} */
		const where = isOwner ? { deletedAt: filter.deleted ? { $ne: null } : null } : publicFilter(site);
		/** @type {Array<Record<string, unknown>>} */
		const and = where.$and ? [.../** @type {any[]} */ (where.$and)] : [];
		delete where.$and;
		if (filter.statuses) where.status = { $in: filter.statuses };
		if (filter.type) where.type = filter.type;
		if (filter.brandId) where.brandId = filter.brandId;
		if (filter.tag) where.tags = filter.tag;
		if (filter.slug) where.slug = filter.slug;
		if (filter.sku) where['variants.sku'] = filter.sku;
		if (filter.externalId) where.externalId = filter.externalId;
		if (filter.inStock !== undefined) where.inStock = filter.inStock;
		if (filter.priceMin !== undefined) and.push({ priceMax: { $gte: filter.priceMin } });
		if (filter.priceMax !== undefined) and.push({ priceMin: { $lte: filter.priceMax } });
		if (filter.collectionId) {
			const collections = await site.repos.collections.list({ limit: 10_000 });
			if (!isOwner && !visibleCollectionIds(collections).has(filter.collectionId))
				return {
					ok: /** @type {const} */ (true),
					items: [],
					spec,
					sort: parsed.sort,
					where: { id: null },
					page: parsed.page,
					total: total ? 0 : null,
				};
			const ids = site.settings.collections.include_descendants
				? withDescendants(collections, filter.collectionId)
				: [filter.collectionId];
			where.collectionIds = { $in: ids };
		}
		if (filter.brandSlugs) {
			const brands = await Promise.all(filter.brandSlugs.map((slug) => site.repos.brands.by('slug', slug)));
			where.brandId = { $in: brands.filter((b) => b && (isOwner || b.visible !== false)).map((b) => b.id) };
		}
		for (const word of filter.words ?? [])
			and.push({ searchTokens: { $regex: `^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } });
		for (const tokens of filter.facets ?? []) and.push({ facets: { $in: tokens } });
		const scope = { ...where, ...(and.length > 0 ? { $and: [...and] } : {}) };
		if (cursor && parsed.page === null) and.push(cursor);
		if (and.length > 0) where.$and = and;
		const skip = parsed.page === null ? 0 : (parsed.page - 1) * (fetchLimit - 1);
		const [items, count] = await Promise.all([
			site.repos.items.list({ filter: where, sort: Object.fromEntries(spec), fetchLimit, skip }),
			total ? site.repos.items.count(scope) : null,
		]);
		return { ok: /** @type {const} */ (true), items, spec, sort: parsed.sort, where: scope, page: parsed.page, total: count };
	};

	return Object.freeze({ create, update, remove, find, list, owner, publicViews, publicFilter, cursorKey });
};

/** @typedef {ReturnType<typeof createItemsService>} ItemsService */

/**
 * Item settings for the item-schema resource (public definitions headless forms and widgets use).
 * @param {Site} site
 * @param {{ owner: boolean }} options
 */
export const itemSchemaView = (site, { owner }) => {
	const { items } = site.settings;
	return {
		types: items.item_types.map((t) => ({
			key: t.key,
			label: t.label,
			kind: t.kind,
			requiresShipping: t.requires_shipping ?? t.kind === 'physical',
		})),
		statuses: owner ? items.statuses : items.statuses.filter((s) => s.visible).map((s) => ({ key: s.key, label: s.label })),
		customFields: (owner ? items.custom_fields : items.custom_fields.filter((f) => f.public)).map((f) => ({
			key: f.key,
			label: f.label,
			type: f.type,
			options: f.options ?? [],
			required: f.required === true,
			...(owner ? { public: f.public === true } : {}),
		})),
		currency: site.settings.currencyOf(null),
		languages: items.languages,
		sorts: items.sorts,
		defaultSort: items.default_sort,
		pageSize: items.page_size,
		...(owner
			? {
					defaultStatus: items.default_status,
					defaultType: items.default_type,
					statusBases: items.statuses.map((s) => statusDef(items.statuses, s.key).base),
				}
			: {}),
	};
};
