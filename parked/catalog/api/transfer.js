/**
 * Import and export service. An import is planned in `core/importing.js` (dry-run diff per item, row errors) and
 * applied through the same item, variant and media services as the API — the same validation, rollups and events.
 * The dry run returns each item's `version`; the apply sends them back as `expectedVersions`, and an item that changed
 * in between is a conflict handled by the conflict policy (skip the item, overwrite anyway, or fail the import before
 * anything is written).
 */
import { diffOf, exportCsv, parseImport, planGroup, templateCsv } from '../core/importing.js';
import { mediaUrl } from '../core/media.js';
import { isObject, issue } from '../core/text.js';
import { attributesOf, fail, invalid } from './catalog.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */

/** Largest CSV body (characters). */
export const MAX_CSV_CHARS = 3_500_000;
const POLICIES = ['skip', 'overwrite', 'fail'];

/**
 * @param {Deps} deps
 * @param {{ items: import('./items.js').ItemsService, variants: import('./variants.js').VariantsService, media: import('./media.js').MediaService }} services
 */
export const createTransferService = (deps, { items, variants, media }) => {
	/**
	 * Run an import (dry run or apply).
	 * @param {Site} site
	 * @param {unknown} body `{ csv, dryRun?, mapping?, conflictPolicy?, expectedVersions? }`
	 * @param {{ key: string, actor: import('./catalog.js').Actor, exposeCost: boolean }} options
	 */
	const run = async (site, body, { key, actor, exposeCost }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const input = /** @type {Record<string, any>} */ (body);
		/** @type {Array<{ path: string, code: string }>} */
		const problems = [];
		if (typeof input.csv !== 'string' || input.csv.length === 0) problems.push(issue('/csv', 'required'));
		else if (input.csv.length > MAX_CSV_CHARS) problems.push(issue('/csv', 'too_large'));
		const mapping = input.mapping ?? {};
		if (
			!isObject(mapping) ||
			Object.entries(mapping).some(([from, to]) => from.length > 120 || typeof to !== 'string' || to.length > 80)
		)
			problems.push(issue('/mapping', 'mapping_invalid'));
		const policy = input.conflictPolicy ?? site.settings.importing.conflict_policy;
		if (!POLICIES.includes(policy)) problems.push(issue('/conflictPolicy', 'policy_invalid'));
		const expected = input.expectedVersions ?? {};
		if (!isObject(expected) || !Object.values(expected).every((v) => Number.isSafeInteger(v)))
			problems.push(issue('/expectedVersions', 'versions_invalid'));
		if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') problems.push(issue('/dryRun', 'boolean_invalid'));
		if (problems.length > 0) return invalid(problems);
		const parsed = parseImport(input.csv, { maxRows: site.settings.importing.max_rows, mapping });
		if (!parsed.ok) return fail('csv_invalid', `The file cannot be imported (${parsed.code}).`);
		const [brands, collections, attributes] = await Promise.all([
			site.repos.brands.list({ limit: 10_000 }),
			site.repos.collections.list({ limit: 10_000 }),
			attributesOf(site),
		]);
		const context = {
			separator: site.settings.importing.list_separator,
			exponentOf: site.settings.exponentOf,
			catalogCurrency: site.settings.currencyOf(null),
			brandId: (/** @type {string} */ slug) =>
				brands.find((/** @type {any} */ b) => b.slug === slug || b.name === slug)?.id ?? null,
			collectionId: (/** @type {string} */ slug) => collections.find((/** @type {any} */ c) => c.slug === slug)?.id ?? null,
			attributes: new Map(attributes.map((a) => [a.key, a])),
			includeCost: site.settings.importing.include_cost,
		};
		const plans = await Promise.all(
			parsed.groups.map(async (group) => {
				const current = group.ref.id
					? await site.repos.items.get(group.ref.id)
					: await site.repos.items.bySlug(/** @type {string} */ (group.ref.slug));
				const plan = planGroup(group, current && !current.deletedAt ? current : null, context);
				const live = current && !current.deletedAt ? current : null;
				if (!live && group.ref.id)
					plan.errors.push({ line: group.rows[0]?.line ?? 0, path: '/item_id', code: 'item_unknown' });
				if (!live && !site.settings.importing.allow_create)
					plan.errors.push({ line: group.rows[0]?.line ?? 0, path: '/item_slug', code: 'create_disabled' });
				const changes = diffOf(live, plan);
				const action = plan.errors.length > 0 ? 'error' : !live ? 'create' : changes.length > 0 ? 'update' : 'unchanged';
				return { group, plan, current: live, changes, action };
			}),
		);
		const report = (/** @type {Record<string, string>} */ outcomes = {}) => ({
			dryRun: input.dryRun !== false,
			columns: parsed.columns,
			ignoredColumns: parsed.ignored,
			summary: {
				items: plans.length,
				create: plans.filter((p) => p.action === 'create').length,
				update: plans.filter((p) => p.action === 'update').length,
				unchanged: plans.filter((p) => p.action === 'unchanged').length,
				errors: plans.filter((p) => p.action === 'error').length + parsed.problems.length,
				...(Object.keys(outcomes).length > 0
					? Object.fromEntries(
							['applied', 'conflict', 'failed', 'skipped'].map((name) => [
								name,
								Object.values(outcomes).filter((o) => o === name).length,
							]),
						)
					: {}),
			},
			rowErrors: parsed.problems,
			items: plans.map((p) => ({
				key: p.group.key,
				lines: p.group.rows.map((r) => r.line),
				itemId: p.current?.id ?? null,
				slug: p.current?.slug ?? p.group.ref.slug,
				action: p.action,
				version: p.current?.version ?? null,
				changes: exposeCost ? p.changes : p.changes.filter((c) => c.field !== 'variant.cost'),
				errors: p.plan.errors,
				...(outcomes[p.group.key] ? { outcome: outcomes[p.group.key] } : {}),
			})),
			versions: Object.fromEntries(plans.filter((p) => p.current).map((p) => [p.current?.id, p.current?.version])),
		});
		if (input.dryRun !== false) return { ok: /** @type {const} */ (true), report: report() };
		const conflicts = plans.filter(
			(p) => p.current && Object.hasOwn(expected, p.current.id) && expected[p.current.id] !== p.current.version,
		);
		if (policy === 'fail' && conflicts.length > 0)
			return fail('conflict', 'Items changed since the dry run; nothing was imported.');
		/** @type {Record<string, string>} */
		const outcomes = {};
		for (const p of plans) {
			if (p.action === 'error') outcomes[p.group.key] = 'failed';
			else if (p.action === 'unchanged') outcomes[p.group.key] = 'skipped';
			else if (policy === 'skip' && conflicts.includes(p)) outcomes[p.group.key] = 'conflict';
			else
				outcomes[p.group.key] = (await apply(site, p, {
					key,
					actor,
					exposeCost,
					expectedVersion: policy === 'overwrite' ? null : (p.current?.version ?? null),
				}))
					? 'applied'
					: 'failed';
		}
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'catalog.imported', after: report(outcomes).summary })
			.catch(() => undefined);
		return { ok: /** @type {const} */ (true), report: report(outcomes) };
	};

	/**
	 * Apply one planned item.
	 * @param {Site} site
	 * @param {{ group: import('../core/importing.js').ImportGroup, plan: ReturnType<typeof planGroup>, current: Record<string, any> | null }} p
	 * @param {{ key: string, actor: import('./catalog.js').Actor, exposeCost: boolean, expectedVersion: number | null }} options
	 */
	const apply = async (site, { group, plan, current }, { key, actor, exposeCost, expectedVersion }) => {
		const base = `${key}:${group.key}`;
		if (!current) {
			const created = await items.create(
				site,
				{ ...plan.item, variants: plan.variants.map((v) => v.fields), media: plan.images.map((url) => ({ url })) },
				{ key: base, actor, exposeCost },
			);
			return created.ok;
		}
		if (Object.keys(plan.item).length > 0) {
			const updated = await items.update(site, current.id, plan.item, { actor, exposeCost, expectedVersion });
			if (!updated.ok) return false;
		}
		for (const [index, variant] of plan.variants.entries()) {
			const result = variant.id
				? await variants.update(site, variant.id, variant.fields, { key: `${base}:v${index}` })
				: await variants.create(site, { itemId: current.id, ...variant.fields }, { key: `${base}:v${index}` });
			if (!result.ok) return false;
		}
		const known = new Set((current.media ?? []).map((/** @type {any} */ m) => m.url));
		for (const [index, url] of plan.images.entries())
			if (!known.has(url) && !(await media.add(site, { itemId: current.id, url }, { key: `${base}:m${index}` })).ok)
				return false;
		return true;
	};

	/**
	 * Export items as CSV (the configured columns; cost only when allowed).
	 * @param {Site} site
	 * @param {Record<string, string | undefined>} query item filters as for `GET /v1/items`
	 * @param {{ exposeCost: boolean }} options
	 */
	const exportItems = async (site, query, { exposeCost }) => {
		const result = await items.list(
			site,
			{ ...query, sort: 'oldest' },
			{ owner: true, after: null, fetchLimit: site.settings.importing.max_rows },
		);
		if (!result.ok) return result;
		const [brands, collections] = await Promise.all([
			site.repos.brands.list({ limit: 10_000 }),
			site.repos.collections.list({ limit: 10_000 }),
		]);
		const csv = exportCsv(result.items, {
			columns: site.settings.importing.columns,
			separator: site.settings.importing.list_separator,
			includeCost: exposeCost && site.settings.importing.include_cost,
			brandSlug: (id) => brands.find((/** @type {any} */ b) => b.id === id)?.slug ?? '',
			collectionSlug: (id) => collections.find((/** @type {any} */ c) => c.id === id)?.slug ?? null,
			currencyOf: (item) => site.settings.currencyOf(item),
			exponentOf: site.settings.exponentOf,
			mediaUrl: (m) => mediaUrl(/** @type {any} */ (m), { baseUrl: site.settings.media.storage_base_url }),
		});
		return { ok: /** @type {const} */ (true), csv, count: result.items.length };
	};

	/** @param {Site} site */
	const template = (site) =>
		templateCsv(site.settings.importing.columns.filter((/** @type {string} */ c) => c !== 'item_id' && c !== 'variant_id'));

	return Object.freeze({ run, exportItems, template });
};

/** @typedef {ReturnType<typeof createTransferService>} TransferService */
