/**
 * The Configurator Builder application service: configurators (create, update, archive, publish), the catalog link,
 * evaluations (resolve + price + URL in one call), quotes and URL parameters. It orchestrates the pure core with the
 * merchant's repositories; the routes, the event consumers and the dashboard all go through it.
 */
import { applyDeleted, applyInventory, applyItem, linkSchema } from '../core/catalog.js';
import { compileSchema } from '../core/compile.js';
import { priceOf } from '../core/pricing.js';
import { checkSelection, resolve } from '../core/resolve.js';
import { isObject, parseSchema } from '../core/schema.js';
import { canonicalSearch, decodeSelection, encodeSelection, mergeSearch } from '../core/urlSync.js';
import { SCHEMA_FIELDS } from '../core/validate.js';
import { publicView } from '../core/views.js';

/** @typedef {import('../core/views.js').ConfiguratorRecord} ConfiguratorRecord */
/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {Repositories} repos
 */
/** @typedef {{ type: string, id?: string }} Actor */
/**
 * @typedef {{ ok: false, reason: string, detail?: string, problems?: Array<{ path: string, code: string, message?: string }>,
 *   extensions?: Record<string, unknown> }} Failure
 */

/** Event published when a configurator is published. */
export const PUBLISHED_EVENT = 'configurator.published@1';

/** Writes to a catalog item retry this often on concurrent updates. */
const ITEM_RETRIES = 5;

/**
 * @param {{ publish: (event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>,
 *   recordUsage: (usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>,
 *   audit: (entry: Record<string, unknown>) => Promise<unknown>, now: () => number, newId: (prefix: string) => string }} deps
 */
export const createConfiguratorService = ({ publish, recordUsage, audit, now, newId }) => {
	const iso = () => new Date(now()).toISOString();
	/** @param {string} reason @param {Partial<Failure>} [extra] @returns {Failure} */
	const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

	/**
	 * A configurator by id (`cfg_…`) or key.
	 * @param {Site} site
	 * @param {string} ref
	 * @returns {Promise<ConfiguratorRecord | null>}
	 */
	const find = async (site, ref) =>
		ref.startsWith('cfg_')
			? ((await site.repos.configurators.byId(ref)) ?? (await site.repos.configurators.byKey(ref)))
			: ((await site.repos.configurators.byKey(ref)) ?? (await site.repos.configurators.byId(ref)));

	/** The schema fields of a body. @param {Record<string, any>} body */
	const schemaFields = (body) =>
		Object.fromEntries(SCHEMA_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));

	/**
	 * Parse a schema with the website's limits and switches.
	 * @param {Site} site
	 * @param {Record<string, any>} input
	 * @returns {{ ok: true, schema: import('../core/schema.js').Schema } | Failure}
	 */
	const parse = (site, input) => {
		const parsed = parseSchema(input, site.settings.limits);
		if (!parsed.ok) return fail('validation_failed', { problems: parsed.problems });
		if (parsed.schema.source.type === 'catalog' && !site.settings.schema.catalog_link)
			return fail('validation_failed', {
				problems: [{ path: '/source/type', code: 'disabled', message: 'catalog link is off' }],
			});
		const compiled = compileSchema(parsed.schema);
		if (!compiled.ok) return fail('validation_failed', { problems: compiled.problems });
		return parsed;
	};

	/** @param {Site} site @param {ConfiguratorRecord} record */
	const announce = async (site, record) => {
		if (record.status !== 'published') return;
		const { source } = record.schema;
		await publish({
			websiteId: site.websiteId,
			type: PUBLISHED_EVENT,
			idempotencyKey: `${record.id}:v${record.version}`,
			data: {
				configuratorId: record.id,
				...(record.key ? { key: record.key } : {}),
				version: record.version,
				...(source.type === 'catalog' ? { itemId: source.itemId } : {}),
				groups: record.schema.groups.map((group) => group.key),
			},
		});
	};

	/**
	 * The concrete (catalog-linked) schema of a configurator, compiled.
	 * @param {Site} site
	 * @param {ConfiguratorRecord} record
	 * @returns {Promise<{ ok: true, schema: import('../core/schema.js').Schema, compiled: import('../core/compile.js').Compiled } | Failure>}
	 */
	const concrete = async (site, record) => {
		let { schema } = record;
		if (schema.source.type === 'catalog') {
			if (!site.settings.schema.catalog_link) return fail('catalog_link_disabled');
			const linked = linkSchema(schema, await site.repos.items.get(schema.source.itemId));
			if (!linked.ok) return fail(linked.code);
			schema = linked.schema;
		}
		const compiled = compileSchema(schema);
		return compiled.ok
			? { ok: true, schema, compiled: compiled.compiled }
			: fail('validation_failed', { problems: compiled.problems });
	};

	/**
	 * A configurator a request may use: published for browser keys and widgets, any non-archived one for servers.
	 * @param {Site} site
	 * @param {string} ref
	 * @param {{ publishedOnly: boolean }} options
	 */
	const usable = async (site, ref, { publishedOnly }) => {
		const record = await find(site, ref);
		if (!record || record.status === 'archived' || (publishedOnly && record.status !== 'published')) return null;
		return record;
	};

	/** @param {Site} site */
	const resolverOptions = (site) => ({
		...site.settings.resolver,
		now: now(),
		states: site.settings.api.option_states !== false,
	});

	/**
	 * Selection of a request: the configurator parameters of `search` (when URL sync is on), overlaid by `selection`.
	 * @param {Site} site
	 * @param {import('../core/compile.js').Compiled} compiled
	 * @param {{ selection?: Record<string, unknown>, search?: string }} body
	 */
	const selectionOf = (site, compiled, body) => ({
		...(typeof body.search === 'string' && site.settings.enabled('url_sync')
			? decodeSelection(urlGroups(compiled), body.search, site.settings.url)
			: {}),
		...(isObject(body.selection) ? body.selection : {}),
	});

	/** @param {import('../core/compile.js').Compiled} compiled */
	const urlGroups = (compiled) => compiled.schema.groups;

	/**
	 * Price of a resolution or checked selection when the price_deltas element is on.
	 * @param {Site} site
	 * @param {import('../core/compile.js').Compiled} compiled
	 * @param {{ selection: Record<string, unknown>, combination: { id: string } | null, quantity: number }} input
	 */
	const priced = (site, compiled, input) => {
		if (!site.settings.enabled('price_deltas')) return { ok: /** @type {const} */ (true), price: null };
		const result = priceOf(compiled, input, {
			rounding: site.settings.rounding,
			currency: site.settings.website.currency,
			now: now(),
			timeZone: site.settings.website.timeZone,
		});
		if (!result.ok || !result.price || site.settings.pricing.show_breakdown) return result;
		return { ok: /** @type {const} */ (true), price: { ...result.price, deltas: [] } };
	};

	/**
	 * Resolve, price and build the URL of a selection.
	 * @param {Site} site
	 * @param {ConfiguratorRecord} record
	 * @param {{ selection?: Record<string, unknown>, changed?: string | null, quantity?: number, search?: string }} body
	 * @param {{ meter: boolean }} options
	 */
	const evaluateRecord = async (site, record, body, { meter }) => {
		const built = await concrete(site, record);
		if (!built.ok) return built;
		const { compiled } = built;
		const resolution = resolve(
			compiled,
			{ selection: selectionOf(site, compiled, body), changed: body.changed ?? null, quantity: body.quantity },
			resolverOptions(site),
		);
		if (meter) await recordUsage({ websiteId: site.websiteId, unit: 'evaluation', quantity: 1, idempotencyKey: newId('evl') });
		if (!resolution.ok) {
			const { code, detail, ...extensions } = resolution.problem;
			return fail(code, { detail, extensions });
		}
		const price = priced(site, compiled, resolution);
		if (!price.ok) return fail(price.code);
		const rest = Object.fromEntries(Object.entries(resolution).filter(([name]) => name !== 'ok'));
		const groups = urlGroups(compiled);
		const itemId = record.schema.source.type === 'catalog' ? record.schema.source.itemId : null;
		return {
			ok: /** @type {const} */ (true),
			evaluation: {
				configurator: { id: record.id, key: record.key, version: record.version },
				...rest,
				price: price.price,
				url: site.settings.enabled('url_sync')
					? {
							search: mergeSearch(body.search ?? '', groups, resolution.selection, site.settings.url),
							canonical: canonicalSearch(groups, resolution.selection, site.settings.url),
							params: encodeSelection(groups, resolution.selection, site.settings.url),
							history: site.settings.url.history,
						}
					: null,
				notify:
					site.settings.resolver.notify && !resolution.inStock
						? {
								configuratorId: record.id,
								itemId,
								variantId: itemId ? (resolution.combination?.id ?? null) : null,
								combinationId: resolution.combination?.id ?? null,
								sku: resolution.combination?.sku ?? null,
							}
						: null,
			},
		};
	};

	/**
	 * @param {Site} site
	 * @param {string} itemId
	 * @param {(item: import('../core/catalog.js').CatalogItem | null) => import('../core/catalog.js').CatalogItem} change
	 */
	const updateItem = async (site, itemId, change) => {
		for (let attempt = 0; attempt < ITEM_RETRIES; attempt += 1) {
			const stored = await site.repos.items.get(itemId);
			const { revision = 0, ...rest } = stored ?? {};
			const current = stored ? /** @type {import('../core/catalog.js').CatalogItem} */ (rest) : null;
			const next = change(current);
			if (current !== null && next === current) return { ok: true, changed: false };
			if (await site.repos.items.put(stored ? revision : 0, { ...next, itemId })) return { ok: true, changed: true };
		}
		return { ok: false, changed: false };
	};

	return Object.freeze({
		find,
		concrete,

		/**
		 * @param {Site} site
		 * @param {Record<string, any>} body
		 * @param {Actor} actor
		 * @returns {Promise<{ ok: true, record: ConfiguratorRecord } | Failure>}
		 */
		create: async (site, body, actor) => {
			const parsed = parse(site, schemaFields(body));
			if (!parsed.ok) return parsed;
			const max = site.settings.schema.max_configurators;
			if ((await site.repos.configurators.countActive()) >= max)
				return fail('limit_reached', { detail: `At most ${max} configurators (archive one first).` });
			const at = iso();
			const status = body.status === 'published' ? 'published' : 'draft';
			/** @type {ConfiguratorRecord} */
			const record = {
				id: newId('cfg'),
				key: parsed.schema.key,
				name: parsed.schema.name,
				status,
				version: 1,
				schema: parsed.schema,
				createdAt: at,
				updatedAt: at,
				publishedAt: status === 'published' ? at : null,
			};
			if (!(await site.repos.configurators.insert(record))) return fail('key_taken');
			await announce(site, record);
			await audit({
				websiteId: site.websiteId,
				actor,
				action: 'configurator.created',
				target: { type: 'configurator', id: record.id },
			});
			return { ok: true, record };
		},

		/**
		 * Replace schema fields (top level) and / or the status; `version` must be the current one.
		 * @param {Site} site
		 * @param {string} ref
		 * @param {Record<string, any>} body
		 * @param {Actor} actor
		 * @returns {Promise<{ ok: true, record: ConfiguratorRecord } | Failure>}
		 */
		update: async (site, ref, body, actor) => {
			const record = await find(site, ref);
			if (!record) return fail('not_found');
			if (record.status === 'archived') return fail('gone');
			if (body.version !== record.version) return fail('conflict', { detail: `The current version is ${record.version}.` });
			const parsed = parse(site, { ...record.schema, ...schemaFields(body) });
			if (!parsed.ok) return parsed;
			const status = body.status ?? record.status;
			const at = iso();
			/** @type {ConfiguratorRecord} */
			const next = {
				...record,
				key: parsed.schema.key,
				name: parsed.schema.name,
				status,
				version: record.version + 1,
				schema: parsed.schema,
				updatedAt: at,
				publishedAt: status === 'published' ? at : record.publishedAt,
			};
			const saved = await site.repos.configurators.save(record.version, next);
			if (saved === 'conflict') return fail('conflict', { detail: 'The configurator changed concurrently; read it again.' });
			if (saved === 'key_taken') return fail('key_taken');
			await announce(site, next);
			await audit({
				websiteId: site.websiteId,
				actor,
				action: 'configurator.updated',
				target: { type: 'configurator', id: next.id },
			});
			return { ok: true, record: next };
		},

		/**
		 * Archive (soft delete): no longer usable, no longer counted.
		 * @param {Site} site
		 * @param {string} ref
		 * @param {Actor} actor
		 * @returns {Promise<{ ok: true, record: ConfiguratorRecord } | Failure>}
		 */
		archive: async (site, ref, actor) => {
			const record = await find(site, ref);
			if (!record) return fail('not_found');
			if (record.status === 'archived') return { ok: true, record };
			const next = { ...record, status: /** @type {const} */ ('archived'), version: record.version + 1, updatedAt: iso() };
			const saved = await site.repos.configurators.save(record.version, next);
			if (saved !== 'ok') return fail('conflict', { detail: 'The configurator changed concurrently; retry.' });
			await audit({
				websiteId: site.websiteId,
				actor,
				action: 'configurator.archived',
				target: { type: 'configurator', id: next.id },
			});
			return { ok: true, record: next };
		},

		/**
		 * Dry-run validation of a schema (editors): problems, or the compiled summary.
		 * @param {Site} site
		 * @param {Record<string, any>} body
		 */
		check: (site, body) => {
			const parsed = parse(site, schemaFields(body));
			if (!parsed.ok) return { valid: false, problems: parsed.problems ?? [] };
			const { schema } = parsed;
			return {
				valid: true,
				problems: [],
				summary: {
					groups: schema.groups.length,
					options: schema.groups.reduce((sum, group) => sum + group.options.length, 0),
					rules: schema.rules.length,
					combinations: schema.combinations.length,
					priced: schema.pricing !== null,
				},
			};
		},

		/**
		 * Public, concrete view of a published configurator (browser keys, widgets, the headless resolver).
		 * @param {Site} site
		 * @param {string} ref
		 * @param {{ publishedOnly: boolean }} options
		 */
		publicView: async (site, ref, options) => {
			const record = await usable(site, ref, options);
			if (!record) return fail('not_found');
			const built = await concrete(site, record);
			return built.ok ? { ok: /** @type {const} */ (true), view: publicView(record, built.schema) } : built;
		},

		/**
		 * `POST /v1/evaluations`.
		 * @param {Site} site
		 * @param {Record<string, any>} body validated
		 * @param {{ publishedOnly: boolean, meter?: boolean }} options
		 */
		evaluate: async (site, body, { publishedOnly, meter = true }) => {
			const record = await usable(site, body.configurator, { publishedOnly });
			if (!record) return fail('not_found');
			return evaluateRecord(site, record, body, { meter });
		},

		/**
		 * Widget bootstrap: the public configurator, the widget settings and the evaluation of the page's URL.
		 * @param {Site} site
		 * @param {string} ref
		 * @param {{ search?: string, publishedOnly: boolean }} options
		 */
		widget: async (site, ref, { search = '', publishedOnly }) => {
			const record = await usable(site, ref, { publishedOnly });
			if (!record) return fail('not_found');
			const built = await concrete(site, record);
			if (!built.ok) return built;
			const evaluated = await evaluateRecord(site, record, { search }, { meter: true });
			const { widget } = site.settings;
			return {
				ok: /** @type {const} */ (true),
				widget: {
					configurator: publicView(record, built.schema),
					settings: {
						layout: widget.layout,
						showPrice: widget.show_price && site.settings.enabled('price_deltas'),
						showSummary: widget.show_summary,
						showOutOfStock: widget.show_out_of_stock,
						showAdjustments: widget.show_adjustments,
						urlSync: site.settings.enabled('url_sync'),
						history: site.settings.url.history,
						inStock: site.settings.resolver.inStock,
					},
					evaluation: evaluated.ok ? evaluated.evaluation : null,
					problem: evaluated.ok ? null : { code: evaluated.reason, detail: evaluated.detail ?? null },
				},
			};
		},

		/**
		 * `POST /v1/quotes`: the price of a selection exactly as given (no resolution).
		 * @param {Site} site
		 * @param {Record<string, any>} body validated
		 * @param {{ publishedOnly: boolean }} options
		 */
		quote: async (site, body, { publishedOnly }) => {
			const record = await usable(site, body.configurator, { publishedOnly });
			if (!record) return fail('not_found');
			const built = await concrete(site, record);
			if (!built.ok) return built;
			const check = checkSelection(
				built.compiled,
				{ selection: body.selection, quantity: body.quantity },
				resolverOptions(site),
			);
			if (!check.valid)
				return fail('selection_invalid', {
					detail: 'The selection is not a valid combination.',
					extensions: { violations: check.violations },
				});
			if (!check.complete)
				return fail('selection_incomplete', {
					detail: 'Required groups have no value.',
					extensions: { missing: check.missing },
				});
			const price = priced(site, built.compiled, check);
			if (!price.ok) return fail(price.code);
			return {
				ok: /** @type {const} */ (true),
				quote: {
					configurator: { id: record.id, key: record.key, version: record.version },
					selection: check.selection,
					combination: check.combination,
					inStock: check.inStock,
					quantity: check.quantity,
					price: price.price,
				},
			};
		},

		/**
		 * `POST /v1/url-params:build` / `:parse`.
		 * @param {Site} site
		 * @param {Record<string, any>} body validated
		 * @param {'build' | 'parse'} mode
		 * @param {{ publishedOnly: boolean }} options
		 */
		urlParams: async (site, body, mode, { publishedOnly }) => {
			const record = await usable(site, body.configurator, { publishedOnly });
			if (!record) return fail('not_found');
			const built = await concrete(site, record);
			if (!built.ok) return built;
			const groups = urlGroups(built.compiled);
			const options = site.settings.url;
			if (mode === 'parse')
				return { ok: /** @type {const} */ (true), result: { selection: decodeSelection(groups, body.search, options) } };
			const selection = isObject(body.selection) ? body.selection : {};
			return {
				ok: /** @type {const} */ (true),
				result: {
					search: mergeSearch(body.search ?? '', groups, selection, options),
					canonical: canonicalSearch(groups, selection, options),
					params: encodeSelection(groups, selection, options),
					history: options.history,
				},
			};
		},

		// ── catalog link (event consumers) ───────────────────────────────────────────────────────────────
		/** @param {Site} site @param {Record<string, any>} data @param {string} occurredAt */
		itemSnapshot: (site, data, occurredAt) => updateItem(site, data.itemId, (item) => applyItem(item, data, occurredAt)),
		/** @param {Site} site @param {string} itemId @param {string} occurredAt */
		itemDeleted: (site, itemId, occurredAt) => updateItem(site, itemId, (item) => applyDeleted(item, itemId, occurredAt)),
		/** @param {Site} site @param {Record<string, any>} data @param {string} occurredAt */
		inventory: (site, data, occurredAt) => updateItem(site, data.itemId, (item) => applyInventory(item, data, occurredAt)),

		/** Dashboard overview. @param {Site} site */
		overview: async (site) => ({
			configurators: await site.repos.configurators.countByStatus(),
			catalogItems: await site.repos.items.count(),
		}),
	});
};

/** @typedef {ReturnType<typeof createConfiguratorService>} ConfiguratorService */
