/**
 * Shared orchestration of the catalog service: the per-website `Site`, the item write pipeline (rollups, version,
 * compare-and-set with retries) and the transactional event outbox.
 *
 * Reliable events: every change pushes its standard events onto the item document in the same atomic write
 * (`outbox`), then `flushItem` publishes them through the kit's durable outbox (`portal.publishEvent`, persisted in the
 * control store before it returns) and pulls them off the item. If the process dies in between, the sweep job
 * republishes the leftovers with the same idempotency keys, which the Portal deduplicates (event ids derive from
 * them). Item snapshots (`item.created@1` / `item.updated@1`) are built at publish time from the stored item.
 */
import { EVENT_TYPES, itemSnapshot } from '../core/events.js';
import { nextTransition, rollupOf } from '../core/items.js';

/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ websiteId: string, settings: Settings, repos: Repositories }} Site */
/** @typedef {{ type: string, id?: string }} Actor */
/** @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }>, status?: number }} Failure */
/**
 * @typedef {object} Deps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} publish
 * @property {(entry: { websiteId: string, actor: Actor, action: string, target?: Record<string, unknown>, before?: unknown, after?: unknown }) => Promise<unknown>} audit
 * @property {(websiteId: string) => Promise<any>} storage the merchant's storage connector
 * @property {import('../adapters/tokens.js').FeedTokens} tokens
 * @property {(prefix: string) => string} newId
 * @property {(text: string) => string} stableId
 * @property {() => number} now
 * @property {{ warn?: (message: string, meta?: Record<string, unknown>) => void, error?: (message: string, meta?: Record<string, unknown>) => void }} [log]
 */

/** Write attempts before a compare-and-set loop gives up (409 conflict). */
export const MAX_ATTEMPTS = 5;

/**
 * @param {string} reason
 * @param {string} [detail]
 * @param {Array<{ path: string, code: string }>} [errors]
 * @returns {Failure}
 */
export const fail = (reason, detail, errors) => ({
	ok: false,
	reason,
	...(detail ? { detail } : {}),
	...(errors ? { errors } : {}),
});

/**
 * @param {Array<{ path: string, code: string }>} errors
 * @returns {Failure}
 */
export const invalid = (errors) => fail('validation_failed', 'The request is not valid.', errors);

/**
 * The website's attributes (bounded by `attributes.max_attributes`).
 * @param {Site} site
 * @returns {Promise<import('../core/attributes.js').Attribute[]>}
 */
export const attributesOf = async (site) => site.repos.attributes.list({ limit: 1000 });

/**
 * A new item state with its rollups, version and timestamps recomputed.
 * @param {Site} site
 * @param {Record<string, any>} next
 * @param {{ attributes: readonly import('../core/attributes.js').Attribute[], now: number }} context
 */
export const finalize = (site, next, { attributes, now }) => {
	const rollup = rollupOf(/** @type {any} */ (next), { attributes, stock: site.settings.stock });
	return {
		...next,
		...rollup,
		sortPriceLow: rollup.priceMin ?? Number.MAX_SAFE_INTEGER,
		sortPriceHigh: rollup.priceMax ?? -1,
		nextTransitionAt: site.settings.items.scheduled_publish ? nextTransition(next, now) : null,
		version: (next.version ?? 0) + 1,
		updatedAt: new Date(now),
	};
};

/**
 * An outbox entry.
 * @param {string} type
 * @param {string} key idempotency key
 * @param {Record<string, unknown>} [data] full data (snapshot types are built at publish time)
 * @param {Record<string, unknown>} [extra] e.g. `{ changed }`
 */
export const entry = (type, key, data, extra = {}) => ({ type, key, ...(data ? { data } : {}), ...extra });

/**
 * Publish an item's outbox entries and pull them off the item. Never throws: a failed publish stays in the outbox for
 * the sweep; an entry the Portal can never accept (invalid data) is dropped and logged.
 * @param {Deps} deps
 * @param {Site} site
 * @param {Record<string, any>} item the stored item (with its `outbox`)
 */
export const flushItem = async (deps, site, item) => {
	const entries = /** @type {Array<Record<string, any>>} */ (item.outbox ?? []);
	if (entries.length === 0) return { published: 0 };
	const needsSnapshot = entries.some((e) => e.type === EVENT_TYPES.created || e.type === EVENT_TYPES.updated);
	const brand = needsSnapshot && item.brandId ? await site.repos.brands.get(item.brandId).catch(() => null) : null;
	const snapshot = needsSnapshot
		? itemSnapshot(item, {
				currency: site.settings.currencyOf(item),
				brandName: brand?.name ?? null,
				statuses: site.settings.items.statuses,
			})
		: null;
	/** @type {string[]} */
	const done = [];
	for (const e of entries) {
		const data =
			e.type === EVENT_TYPES.created
				? snapshot
				: e.type === EVENT_TYPES.updated
					? { ...snapshot, changed: e.changed }
					: e.data;
		try {
			await deps.publish({
				websiteId: site.websiteId,
				type: e.type,
				data: /** @type {Record<string, unknown>} */ (data),
				idempotencyKey: e.key,
			});
			done.push(e.key);
		} catch (error) {
			const code = /** @type {{ code?: string }} */ (error)?.code;
			deps.log?.warn?.('catalog event not published', { type: e.type, code: code ?? 'error' });
			if (code === 'invalid_event') done.push(e.key);
		}
	}
	if (done.length > 0) await site.repos.items.acknowledge(item.id, done).catch(() => undefined);
	return { published: done.length };
};

/**
 * Change an item with compare-and-set retries. `change` returns the next state and its outbox entries, a failure,
 * or `null` for "nothing to do" (the current item is returned).
 * @template T
 * @param {Deps} deps
 * @param {Site} site
 * @param {() => Promise<Record<string, any> | null>} load
 * @param {(item: Record<string, any>, attributes: import('../core/attributes.js').Attribute[]) => Promise<{ next: Record<string, any>, entries: Array<Record<string, unknown>>, result?: T } | Failure | null> | { next: Record<string, any>, entries: Array<Record<string, unknown>>, result?: T } | Failure | null} change
 * @returns {Promise<{ ok: true, item: Record<string, any>, result?: T } | Failure>}
 */
export const mutateItem = async (deps, site, load, change) => {
	const attributes = await attributesOf(site);
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const current = await load();
		if (!current) return fail('not_found', 'No such item.');
		const outcome = await change(current, attributes);
		if (outcome === null) return { ok: /** @type {const} */ (true), item: current };
		if ('ok' in outcome && outcome.ok === false) return outcome;
		const planned = /** @type {{ next: Record<string, any>, entries: Array<Record<string, unknown>>, result?: T }} */ (outcome);
		const next = finalize(site, planned.next, { attributes, now: deps.now() });
		if (await site.repos.items.write(next, current.version ?? 1, planned.entries)) {
			const stored = { ...next, outbox: [...(current.outbox ?? []), ...planned.entries] };
			await flushItem(deps, site, stored);
			return {
				ok: /** @type {const} */ (true),
				item: stored,
				...(planned.result === undefined ? {} : { result: planned.result }),
			};
		}
	}
	return fail('conflict', 'The item changed while saving; try again.');
};

/**
 * `item.updated@1` entry for a change (none when nothing tracked changed).
 * @param {Record<string, any>} next
 * @param {string[]} changed
 */
export const updatedEntry = (next, changed) =>
	changed.length > 0
		? [
				entry(EVENT_TYPES.updated, `item.updated:${next.id}:${(next.version ?? 0) + 1}`, undefined, {
					changed: changed.slice(0, 100),
				}),
			]
		: [];
