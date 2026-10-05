/**
 * Taxonomy service: attributes (with facet counts), the collections tree (moves carry the sub-tree along; depth and
 * cycles are refused) and brands. Ids derive from the Idempotency-Key. Deleting something still in use (items, child
 * collections) is refused with `in_use`, so no item silently loses a reference.
 */
import { validateAttribute } from '../core/attributes.js';
import { validateBrand } from '../core/brands.js';
import { buildTree, descendantPlaces, placeIn, validateCollection, visibleCollectionIds } from '../core/collections.js';
import { attributeView, brandView, collectionView } from '../core/views.js';
import { isDuplicateKey } from '../adapters/db.js';
import { fail, invalid } from './catalog.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */

/**
 * @param {Deps} deps
 */
export const createTaxonomyService = (deps) => {
	/**
	 * Insert with a derived id; a duplicate id is a replay, a duplicate key/slug a conflict.
	 * @param {any} repo
	 * @param {Record<string, unknown>} doc
	 * @param {string} conflictReason
	 */
	const insertOnce = async (repo, doc, conflictReason) => {
		try {
			return { ok: /** @type {const} */ (true), value: await repo.insert(doc), created: true };
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
			const existing = await repo.get(doc.id);
			return existing
				? { ok: /** @type {const} */ (true), value: existing, created: false }
				: fail(conflictReason, 'Another entry already uses this key or slug.');
		}
	};

	// ── attributes ───────────────────────────────────────────────────────────────────────────────────────────
	/** @param {Site} site @param {unknown} body @param {{ key: string }} options */
	const createAttribute = async (site, body, { key }) => {
		const id = `att_${deps.stableId(`${site.websiteId}|attribute|${key}`)}`;
		const replay = await site.repos.attributes.get(id);
		if (replay) return { ok: /** @type {const} */ (true), value: replay, created: false };
		const { attributes } = site.settings;
		if ((await site.repos.attributes.count()) >= attributes.max_attributes)
			return fail('limit_reached', `This website may define ${attributes.max_attributes} attributes.`);
		const result = validateAttribute(body, {
			cardPositions: attributes.card_positions,
			maxOptions: attributes.max_options_per_attribute,
		});
		if (!result.value) return invalid(result.problems);
		return insertOnce(site.repos.attributes, { id, ...result.value }, 'key_taken');
	};

	/** @param {Site} site @param {string} id @param {unknown} body */
	const updateAttribute = async (site, id, body) => {
		const current = await site.repos.attributes.get(id);
		if (!current) return fail('not_found', 'No such attribute.');
		const { attributes } = site.settings;
		const result = validateAttribute(body, {
			current,
			cardPositions: attributes.card_positions,
			maxOptions: attributes.max_options_per_attribute,
		});
		if (!result.value) return invalid(result.problems);
		const removed = current.options.filter((/** @type {any} */ o) => !result.value?.options.some((n) => n.value === o.value));
		for (const option of removed)
			if (
				(await site.repos.items.exists({ [`attributes.${current.key}`]: option.value })) ||
				(await site.repos.items.exists({ [`variants.options.${current.key}`]: option.value }))
			)
				return fail('in_use', `Option ${option.value} is used by items.`);
		return { ok: /** @type {const} */ (true), value: await site.repos.attributes.update(id, result.value) };
	};

	/** @param {Site} site @param {string} id */
	const removeAttribute = async (site, id) => {
		const current = await site.repos.attributes.get(id);
		if (!current) return fail('not_found', 'No such attribute.');
		if (
			(await site.repos.items.exists({ [`attributes.${current.key}`]: { $exists: true } })) ||
			(await site.repos.items.exists({ options: current.key }))
		)
			return fail('in_use', 'Items use this attribute.');
		await site.repos.attributes.remove(id);
		return { ok: /** @type {const} */ (true) };
	};

	/**
	 * Facet counts per filterable attribute over the public items of the filter (`GET /v1/attributes:facets`).
	 * @param {Site} site
	 * @param {Record<string, unknown>} filter public item filter (already scoped)
	 * @param {{ collectionIds: string[] | null }} scope
	 */
	const facets = async (site, filter, { collectionIds }) => {
		const all = await site.repos.attributes.list({ limit: 1000 });
		const filterable = all.filter(
			(/** @type {any} */ a) =>
				a.filterable &&
				(collectionIds === null ||
					a.collectionIds.length === 0 ||
					a.collectionIds.some((/** @type {string} */ c) => collectionIds.includes(c))),
		);
		const counts = await site.repos.items.facetCounts(filter, {
			scan: site.settings.attributes.facet_items_scan,
			prefixes: filterable.map((/** @type {any} */ a) => a.key),
		});
		const max = site.settings.attributes.max_facet_values;
		return filterable.map((/** @type {any} */ attribute) => {
			const view = attributeView(attribute);
			const values = counts
				.filter((row) => row.token.startsWith(`${attribute.key}:`))
				.map((row) => {
					const value = row.token.slice(attribute.key.length + 1);
					const option = view.options.find((o) => o.value === value);
					return { value, label: option?.display ?? value, count: row.count };
				})
				.sort((a, b) => {
					const ia = view.options.findIndex((o) => o.value === a.value);
					const ib = view.options.findIndex((o) => o.value === b.value);
					return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib) || b.count - a.count;
				})
				.slice(0, max);
			return {
				key: attribute.key,
				label: attribute.label,
				type: attribute.type,
				unit: attribute.unit,
				visibility: attribute.visibility,
				values,
			};
		});
	};

	// ── collections ──────────────────────────────────────────────────────────────────────────────────────────
	/** @param {Site} site @param {unknown} body @param {{ key: string }} options */
	const createCollection = async (site, body, { key }) => {
		const id = `col_${deps.stableId(`${site.websiteId}|collection|${key}`)}`;
		const replay = await site.repos.collections.get(id);
		if (replay) return { ok: /** @type {const} */ (true), value: replay, created: false };
		const { collections } = site.settings;
		const all = await site.repos.collections.list({ limit: 10_000 });
		if (all.length >= collections.max_collections)
			return fail('limit_reached', `This website may have ${collections.max_collections} collections.`);
		const result = validateCollection(body, { seoFields: collections.seo_fields });
		if (!result.value) return invalid(result.problems);
		const place = placeIn(all, { id: null, parentId: result.value.parentId, maxDepth: collections.max_depth });
		if (!place.ok) return invalid([{ path: '/parentId', code: place.code }]);
		return insertOnce(
			site.repos.collections,
			{ id, ...result.value, ancestors: place.ancestors, depth: place.depth },
			'slug_taken',
		);
	};

	/** @param {Site} site @param {string} id @param {unknown} body */
	const updateCollection = async (site, id, body) => {
		const all = await site.repos.collections.list({ limit: 10_000 });
		const current = all.find((/** @type {any} */ c) => c.id === id);
		if (!current) return fail('not_found', 'No such collection.');
		const { collections } = site.settings;
		const result = validateCollection(body, { current, seoFields: collections.seo_fields });
		if (!result.value) return invalid(result.problems);
		const place = placeIn(all, { id, parentId: result.value.parentId, maxDepth: collections.max_depth });
		if (!place.ok) return invalid([{ path: '/parentId', code: place.code }]);
		try {
			const value = await site.repos.collections.update(id, {
				...result.value,
				ancestors: place.ancestors,
				depth: place.depth,
			});
			if (current.parentId !== result.value.parentId)
				await site.repos.collections.updateMany(
					descendantPlaces(all, id, place).map((p) => ({ id: p.id, fields: { ancestors: p.ancestors, depth: p.depth } })),
				);
			return { ok: /** @type {const} */ (true), value };
		} catch (error) {
			if (isDuplicateKey(error)) return fail('slug_taken', 'Another collection uses this slug.');
			throw error;
		}
	};

	/** @param {Site} site @param {string} id */
	const removeCollection = async (site, id) => {
		const current = await site.repos.collections.get(id);
		if (!current) return fail('not_found', 'No such collection.');
		const children = await site.repos.collections.list({ filter: { parentId: id }, limit: 1 });
		if (children.length > 0 || (await site.repos.items.exists({ collectionIds: id, deletedAt: null })))
			return fail('in_use', 'The collection has sub-collections or items.');
		await site.repos.collections.remove(id);
		return { ok: /** @type {const} */ (true) };
	};

	/**
	 * Collections for readers: owners see all, shoppers the visible cascade.
	 * @param {Site} site
	 * @param {{ owner: boolean, tree: boolean, parentId?: string | null }} options
	 */
	const listCollections = async (site, { owner, tree, parentId }) => {
		const all = await site.repos.collections.list({ limit: 10_000 });
		const visible = visibleCollectionIds(all);
		const readable = owner ? all : all.filter((/** @type {any} */ c) => visible.has(c.id));
		const scoped = parentId === undefined ? readable : readable.filter((/** @type {any} */ c) => c.parentId === parentId);
		const mediaBase = site.settings.media.storage_base_url;
		const views = scoped.map((/** @type {any} */ c) => collectionView(c, { owner, mediaBase }));
		return tree ? buildTree(/** @type {any} */ (views)) : views;
	};

	/** @param {Site} site @param {string} ref id or slug @param {{ owner: boolean }} options */
	const getCollection = async (site, ref, { owner }) => {
		const all = await site.repos.collections.list({ limit: 10_000 });
		const collection = all.find((/** @type {any} */ c) => c.id === ref || c.slug === ref);
		if (!collection || (!owner && !visibleCollectionIds(all).has(collection.id))) return null;
		return {
			...collectionView(collection, { owner, mediaBase: site.settings.media.storage_base_url }),
			breadcrumbs: collection.ancestors
				.map((/** @type {string} */ a) => all.find((/** @type {any} */ c) => c.id === a))
				.filter(Boolean)
				.map((/** @type {any} */ c) => ({ id: c.id, slug: c.slug, title: c.title })),
		};
	};

	// ── brands ───────────────────────────────────────────────────────────────────────────────────────────────
	/** @param {Site} site @param {unknown} body @param {{ key: string }} options */
	const createBrand = async (site, body, { key }) => {
		const id = `brd_${deps.stableId(`${site.websiteId}|brand|${key}`)}`;
		const replay = await site.repos.brands.get(id);
		if (replay) return { ok: /** @type {const} */ (true), value: replay, created: false };
		if ((await site.repos.brands.count()) >= site.settings.brands.max_brands)
			return fail('limit_reached', `This website may have ${site.settings.brands.max_brands} brands.`);
		const result = validateBrand(body);
		if (!result.value) return invalid(result.problems);
		return insertOnce(site.repos.brands, { id, ...result.value }, 'slug_taken');
	};

	/** @param {Site} site @param {string} id @param {unknown} body */
	const updateBrand = async (site, id, body) => {
		const current = await site.repos.brands.get(id);
		if (!current) return fail('not_found', 'No such brand.');
		const result = validateBrand(body, { current });
		if (!result.value) return invalid(result.problems);
		try {
			return { ok: /** @type {const} */ (true), value: await site.repos.brands.update(id, result.value) };
		} catch (error) {
			if (isDuplicateKey(error)) return fail('slug_taken', 'Another brand uses this slug.');
			throw error;
		}
	};

	/** @param {Site} site @param {string} id */
	const removeBrand = async (site, id) => {
		if (!(await site.repos.brands.get(id))) return fail('not_found', 'No such brand.');
		if (await site.repos.items.exists({ brandId: id, deletedAt: null })) return fail('in_use', 'Items use this brand.');
		await site.repos.brands.remove(id);
		return { ok: /** @type {const} */ (true) };
	};

	/** @param {Site} site @param {{ owner: boolean }} options */
	const listBrands = async (site, { owner }) => {
		const all = await site.repos.brands.list({ sort: { position: 1, name: 1 }, limit: 10_000 });
		const mediaBase = site.settings.media.storage_base_url;
		return all
			.filter((/** @type {any} */ b) => owner || b.visible)
			.map((/** @type {any} */ b) => brandView(b, { owner, mediaBase }));
	};

	return Object.freeze({
		createAttribute,
		updateAttribute,
		removeAttribute,
		facets,
		createCollection,
		updateCollection,
		removeCollection,
		listCollections,
		getCollection,
		createBrand,
		updateBrand,
		removeBrand,
		listBrands,
	});
};

/** @typedef {ReturnType<typeof createTaxonomyService>} TaxonomyService */
