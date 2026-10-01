/**
 * The Grades application service: tiers on items, variants and units, the catalog event integration, filters,
 * mappings, warranty and showcase reads. It talks to the merchant's database through the repositories, the Event Hub
 * through `publish` and the audit log through `audit`; the rules live in core/. Inspections are in inspections.js.
 */
import { catalogTiers, effectiveTier, rollupTiers, snapshotPatch, variantKey } from '../core/items.js';
import { filterOptions, sortByTier } from '../core/filters.js';
import { offerProperties, valuesFor } from '../core/mapping.js';
import { showcaseEntries } from '../core/showcase.js';
import { translator } from '../core/text.js';
import { appliesTo, tierView } from '../core/tiers.js';
import { warrantyTerms } from '../core/warranty.js';
import { createInspectionService } from './inspections.js';

/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 */
/** @typedef {{ type: string, id?: string }} Actor */
/** @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Failure */

/**
 * @typedef {object} ServiceDeps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} publish
 * @property {(entry: Record<string, unknown>) => Promise<unknown>} audit
 * @property {(websiteId: string) => Promise<any>} storage the merchant's storage connector
 * @property {import('../adapters/tokens.js').ReportTokens} reports
 * @property {(text: string) => string} hash
 * @property {Record<string, Record<string, string>>} strings
 * @property {() => number} [now]
 */

/** Event published when the tier of an item, variant or unit changes. */
export const TIER_ASSIGNED = 'grades.tier_assigned@1';

/**
 * @param {ServiceDeps} deps
 */
export const createGradesService = ({ publish, audit, storage, reports, hash, strings, now = Date.now }) => {
	/** @param {string} websiteId @param {string} prefix @param {string} key */
	const idFor = (websiteId, prefix, key) => `${prefix}_${hash(`${websiteId}|${prefix}|${key}`)}`;
	const iso = () => new Date(now()).toISOString();

	/**
	 * A translator for a language (the website's, a requested one, else the default catalog).
	 * @param {string | null | undefined} lang
	 */
	const translate = (lang) => {
		const base = strings.en ?? {};
		const primary = typeof lang === 'string' ? lang.split('-')[0] : undefined;
		const exact = typeof lang === 'string' ? strings[lang] : undefined;
		return translator({ ...base, ...(primary ? (strings[primary] ?? {}) : {}), ...(exact ?? {}) });
	};

	/**
	 * Publish best effort (the change is stored either way; the Portal dedupes on the idempotency key).
	 * @param {Parameters<ServiceDeps['publish']>[0]} event
	 */
	const emit = async (event) => {
		try {
			await publish(event);
		} catch {
			// an unreachable Event Hub never fails a change
		}
	};

	/** @param {Site} site @param {Actor} actor @param {string} action @param {Record<string, unknown>} target @param {unknown} [after] */
	const record = async (site, actor, action, target, after) => {
		try {
			await audit({ websiteId: site.websiteId, actor, action, target, ...(after === undefined ? {} : { after }) });
		} catch {
			// best effort: the merchant database already holds the change
		}
	};

	/**
	 * @param {Site} site
	 * @param {{ itemId: string, variantId?: string | null, unitId?: string | null, tier: string | null,
	 *   previousTier: string | null, source: string }} change
	 */
	const tierChanged = (site, change) =>
		emit({
			websiteId: site.websiteId,
			type: TIER_ASSIGNED,
			idempotencyKey: `${change.unitId ?? `${change.itemId}:${variantKey(change.variantId)}`}:${change.tier ?? '-'}:${now()}`,
			data: {
				itemId: change.itemId,
				...(change.variantId ? { variantId: change.variantId } : {}),
				...(change.unitId ? { unitId: change.unitId } : {}),
				tier: change.tier,
				...(change.previousTier ? { previousTier: change.previousTier } : {}),
				source: change.source,
			},
		});

	/**
	 * Why a tier cannot be given to an item (null = it can).
	 * @param {Site} site
	 * @param {string} tierKey
	 * @param {string} itemId
	 * @param {string} path JSON Pointer of the tier in the request
	 * @returns {Promise<Failure | null>}
	 */
	const tierProblem = async (site, tierKey, itemId, path) => {
		const tier = site.settings.index.get(tierKey);
		if (!tier) return { ok: false, reason: 'tier_unknown', errors: [{ path, code: 'tier_unknown' }] };
		const item = await site.repos.items.get(itemId);
		if (!appliesTo(tier, item, { now: now(), timeZone: site.settings.timeZone }))
			return { ok: false, reason: 'tier_not_applicable', errors: [{ path, code: 'tier_not_applicable' }] };
		return null;
	};

	/**
	 * Recompute the tiers an item is offered in (assignments + available units).
	 * @param {Site} site
	 * @param {string} itemId
	 */
	const refreshItem = async (site, itemId) => {
		const [assignments, unitTiers] = await Promise.all([
			site.repos.assignments.forItem(itemId),
			site.repos.units.tiersForItem(itemId),
		]);
		const tiers = rollupTiers(site.settings.index, { assignments, unitTiers });
		await site.repos.items.setTiers(itemId, tiers);
		return tiers;
	};

	/**
	 * Owner view of an assignment.
	 * @param {Record<string, any>} row
	 */
	const assignmentView = (row) => ({
		id: row.id,
		itemId: row.itemId,
		variantId: row.variantId ?? null,
		tier: row.tier,
		note: row.note ?? null,
		source: row.source,
		assignedAt: row.assignedAt,
	});

	/**
	 * Set the tier of an item or variant (idempotent: the same tier again changes nothing).
	 * @param {Site} site
	 * @param {{ itemId: string, variantId?: string | null, tier: string, note?: string | null, source?: string, actor: Actor }} input
	 * @returns {Promise<{ ok: true, assignment: ReturnType<typeof assignmentView>, created: boolean } | Failure>}
	 */
	const assign = async (site, { itemId, variantId = null, tier, note = null, source = 'api', actor }) => {
		const problem = await tierProblem(site, tier, itemId, '/tier');
		if (problem) return problem;
		await site.repos.items.ensure(itemId);
		const key = variantKey(variantId);
		const previous = await site.repos.assignments.upsert({
			id: idFor(site.websiteId, 'gas', `${itemId}|${key}`),
			itemId,
			variantId,
			variantKey: key,
			tier,
			note,
			source,
			actor,
		});
		await refreshItem(site, itemId);
		const stored = /** @type {Record<string, any>} */ (
			await site.repos.assignments.get(idFor(site.websiteId, 'gas', `${itemId}|${key}`))
		);
		if (previous?.tier !== tier) {
			await tierChanged(site, { itemId, variantId, tier, previousTier: previous?.tier ?? null, source });
			if (actor.type !== 'system')
				await record(site, actor, 'tier.assign', { itemId, variantId }, { tier, previous: previous?.tier ?? null });
		}
		return { ok: true, assignment: assignmentView(stored), created: previous === null };
	};

	/**
	 * Remove an assignment.
	 * @param {Site} site
	 * @param {string} id
	 * @param {Actor} actor
	 * @returns {Promise<boolean>}
	 */
	const unassign = async (site, id, actor) => {
		const removed = await site.repos.assignments.remove(id);
		if (!removed) return false;
		await refreshItem(site, removed.itemId);
		await tierChanged(site, {
			itemId: removed.itemId,
			variantId: removed.variantId ?? null,
			tier: null,
			previousTier: removed.tier,
			source: 'api',
		});
		await record(site, actor, 'tier.unassign', { itemId: removed.itemId, variantId: removed.variantId ?? null });
		return true;
	};

	/**
	 * The public tier view of one item: the item-level tier, each assigned variant's tier and every tier the item is
	 * offered in (assignments and available units), best first.
	 * @param {Site} site
	 * @param {string} itemId
	 */
	const itemTiers = async (site, itemId) => {
		const { settings } = site;
		const [item, assignments] = await Promise.all([site.repos.items.get(itemId), site.repos.assignments.forItem(itemId)]);
		const deleted = Boolean(item?.deletedAt);
		const view = (/** @type {string | null} */ key) => {
			const tier = key ? settings.index.get(key) : undefined;
			return tier && tier.active ? tierView(tier, settings.badgeStyle) : null;
		};
		const own = deleted ? null : effectiveTier(assignments, null, settings.defaultTier);
		const variants = deleted
			? []
			: assignments
					.filter((row) => row.variantId)
					.map((row) => ({ variantId: row.variantId, tier: view(row.tier) }))
					.filter((row) => row.tier !== null);
		const offered = deleted ? [] : [...(item?.tiers ?? [])];
		if (!deleted && offered.length === 0 && own) offered.push(own);
		return {
			itemId,
			tier: view(own),
			variants,
			tiers: offered.map(view).filter((tier) => tier !== null),
		};
	};

	/**
	 * Tier views of many items (badges on listings).
	 * @param {Site} site
	 * @param {string[]} itemIds
	 */
	const manyItemTiers = async (site, itemIds) => Promise.all(itemIds.map((itemId) => itemTiers(site, itemId)));

	// ── catalog events ──────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * `item.created@1` / `item.updated@1`: store the snapshot and, when the catalog names tiers through the configured
	 * attribute, assign them (manual assignments are never overwritten; catalog ones follow the catalog).
	 * @param {Site} site
	 * @param {{ data: Record<string, any> }} event
	 */
	const itemUpserted = async (site, { data }) => {
		const { itemId } = data;
		const patch = snapshotPatch(data);
		await site.repos.items.upsertSnapshot(itemId, patch);
		const attribute = String(site.settings.tiersConfig.catalog_attribute ?? '');
		const carriesTiers = attribute !== '' && (patch.attributes !== undefined || patch.variants !== undefined);
		if (!carriesTiers) return refreshItem(site, itemId);
		const item = /** @type {Record<string, any>} */ (await site.repos.items.get(itemId));
		const named = catalogTiers(item, site.settings.tiers, attribute).filter((row) =>
			appliesTo(/** @type {any} */ (site.settings.index.get(row.tier)), item, {
				now: now(),
				timeZone: site.settings.timeZone,
			}),
		);
		const existing = new Map((await site.repos.assignments.forItem(itemId)).map((row) => [row.variantKey, row]));
		for (const row of named) {
			const key = variantKey(row.variantId);
			const current = existing.get(key);
			if (current && (current.source !== 'catalog' || current.tier === row.tier)) continue;
			await site.repos.assignments.upsert({
				id: idFor(site.websiteId, 'gas', `${itemId}|${key}`),
				itemId,
				variantId: row.variantId,
				variantKey: key,
				tier: row.tier,
				note: null,
				source: 'catalog',
				actor: { type: 'system' },
			});
			await tierChanged(site, {
				itemId,
				variantId: row.variantId,
				tier: row.tier,
				previousTier: current?.tier ?? null,
				source: 'catalog',
			});
		}
		await site.repos.assignments.pruneCatalog(
			itemId,
			named.map((row) => variantKey(row.variantId)),
		);
		return refreshItem(site, itemId);
	};

	/**
	 * `item.deleted@1`: the item leaves filters, badges and mappings (assignments and units stay for history).
	 * @param {Site} site
	 * @param {{ data: Record<string, any> }} event
	 */
	const itemDeleted = async (site, { data }) => {
		await site.repos.items.markDeleted(data.itemId);
	};

	// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Filter options of a listing (one collection or the whole catalog).
	 * @param {Site} site
	 * @param {string | null} collection
	 */
	const filters = async (site, collection) => {
		const { settings } = site;
		const counts = await site.repos.items.tierCounts(collection);
		return {
			param: settings.filters.param_name,
			multiSelect: settings.filters.multi_select,
			defaultSort: settings.filters.default_sort,
			collection,
			options: filterOptions({
				tiers: settings.tiers,
				counts,
				config: settings.filters,
				collection,
				badgeStyle: settings.badgeStyle,
				now: now(),
				timeZone: settings.timeZone,
			}),
		};
	};

	/**
	 * Items ordered by tier.
	 * @param {Site} site
	 * @param {string[]} itemIds
	 * @param {'tier_order' | 'tier_order_desc' | 'none'} direction
	 */
	const sortItems = async (site, itemIds, direction) => {
		const docs = await site.repos.items.getMany(itemIds);
		const tiersByItem = new Map(
			docs.filter((doc) => !doc.deletedAt).map((/** @type {any} */ doc) => [doc.itemId, doc.tiers ?? []]),
		);
		return sortByTier(itemIds, tiersByItem, site.settings.index, direction);
	};

	// ── warranty, showcase, mapping ─────────────────────────────────────────────────────────────────────────────

	/**
	 * @param {Site} site
	 * @param {string | null | undefined} lang
	 */
	const warranty = (site, lang) =>
		warrantyTerms({
			tiers: site.settings.tiers.filter((tier) => tier.active),
			config: site.settings.warranty,
			t: translate(lang),
		});

	/**
	 * Showcase entries, optionally for one tier or for the tiers of one item.
	 * @param {Site} site
	 * @param {{ tier?: string | null, itemId?: string | null, lang?: string | null }} input
	 */
	const showcase = async (site, { tier = null, itemId = null, lang = null }) => {
		const only = tier
			? new Set([tier])
			: itemId
				? new Set((await itemTiers(site, itemId)).tiers.map((view) => view.key))
				: null;
		const terms = site.settings.enabled('warranty') ? new Map(warranty(site, lang).map((term) => [term.tier, term])) : null;
		return {
			layout: site.settings.showcase.layout,
			entries: showcaseEntries({
				tiers: site.settings.tiers,
				config: site.settings.showcase,
				badgeStyle: site.settings.badgeStyle,
				warranty: terms,
				only,
			}),
		};
	};

	/**
	 * Conditions of an item in every vocabulary: per variant, at item level and for every tier it is offered in, with
	 * the structured-data properties to merge into Offer nodes.
	 * @param {Site} site
	 * @param {string} itemId
	 */
	const conditions = async (site, itemId) => {
		const view = await itemTiers(site, itemId);
		const { vocabularies } = site.settings;
		const of = (/** @type {ReturnType<typeof tierView> | null} */ tier) => ({
			tier,
			values: valuesFor(vocabularies, tier?.key ?? null),
			offer: offerProperties(vocabularies, tier?.key ?? null),
		});
		return {
			itemId,
			vocabularies: vocabularies.map((v) => ({
				key: v.key,
				name: v.name,
				target: v.target,
				property: v.property,
				display: v.display,
			})),
			item: view.tier ? of(view.tier) : null,
			variants: view.variants.map((row) => ({ variantId: row.variantId, ...of(row.tier) })),
			tiers: view.tiers.map((tier) => of(tier)),
		};
	};

	/**
	 * A page of feed rows (item, variant, tier, value) of one vocabulary.
	 * @param {Site} site
	 * @param {import('../core/mapping.js').Vocabulary} vocabulary
	 * @param {{ after: string | null, fetchLimit: number }} page
	 */
	const feedRows = async (site, vocabulary, page) =>
		(await site.repos.assignments.list(page))
			.filter((row) => site.settings.index.get(row.tier)?.active)
			.map((row) => ({
				itemId: row.itemId,
				variantId: row.variantId ?? null,
				variantKey: row.variantKey,
				tier: row.tier,
				[vocabulary.property]: vocabulary.byTier[row.tier] ?? vocabulary.fallback,
			}));

	/**
	 * Dashboard overview counts.
	 * @param {Site} site
	 */
	const overview = async (site) => {
		const [items, assignments, units, inspections] = await Promise.all([
			site.repos.items.counts(),
			site.repos.assignments.countByTier(),
			site.repos.units.countByTier(),
			site.repos.inspections.countByStatus(),
		]);
		return {
			items,
			tiers: site.settings.tiers.map((tier) => ({
				key: tier.key,
				label: tier.label,
				assignments: assignments.get(tier.key) ?? 0,
				units: units.get(tier.key) ?? 0,
			})),
			ungradedUnits: units.get('') ?? 0,
			inspections,
		};
	};

	const inspections = createInspectionService({
		storage,
		reports,
		idFor,
		now,
		emit,
		record,
		refreshItem,
		tierProblem,
		tierChanged,
	});

	return {
		idFor,
		iso,
		translate,
		assign,
		unassign,
		assignmentView,
		refreshItem,
		tierProblem,
		tierChanged,
		record,
		itemTiers,
		manyItemTiers,
		itemUpserted,
		itemDeleted,
		filters,
		sortItems,
		warranty,
		showcase,
		conditions,
		feedRows,
		overview,
		...inspections,
	};
};

/** @typedef {ReturnType<typeof createGradesService>} GradesService */
