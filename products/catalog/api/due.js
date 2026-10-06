/**
 * Due work without timers. Three things become due with time alone: a scheduled publish / unpublish time passes
 * (`item.updated@1` with `changed: ['published' | 'unpublished']`), a stock reservation's hold ends, and an outbox entry
 * a crashed request left on an item waits to be republished. None of it runs on a schedule:
 *
 * - **on read** (`settle`): an item a request reads (listings, item pages, the dashboard) whose transition time passed
 *   gets its event published, and one with outbox entries older than `OUTBOX_GRACE_MS` gets them republished — only
 *   the items that request returned;
 * - **on access** (variants service): an expired hold is released when it is read, before a new reservation or an order
 *   takes stock, and on an idempotent replay;
 * - **from the dashboard** (`runDue`, "Process due changes"): the same three steps for that website, bounded.
 *
 * Correctness never waits for any of it: public listings filter on the publish / unpublish times at read time, and an
 * expired hold is reported as expired whenever it is read.
 */
import { EVENT_TYPES } from '../core/events.js';
import { isPublic, nextTransition } from '../core/items.js';
import { flushItem } from './catalog.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */

/** Outbox entries younger than this belong to a request still running (it publishes them itself). */
export const OUTBOX_GRACE_MS = 60_000;
/** Records per step of one dashboard run. */
export const DUE_BATCH = 200;

/**
 * @param {Date | string | null | undefined} at
 * @returns {number | null}
 */
const timeOf = (at) => {
	if (at === null || at === undefined) return null;
	const t = at instanceof Date ? at.getTime() : Date.parse(at);
	return Number.isNaN(t) ? null : t;
};

/**
 * @param {Deps} deps
 * @param {{ variants: { expire: (site: Site, limit: number) => Promise<number> } }} services
 */
export const createDueWork = (deps, { variants }) => {
	/**
	 * Publish the visibility change of an item whose transition time passed (compare-and-set: one writer wins).
	 * @param {Site} site
	 * @param {Record<string, any>} item
	 * @returns {Promise<number>} 1 when published
	 */
	const transition = async (site, item) => {
		const now = deps.now();
		const visible = isPublic(/** @type {any} */ (item), { statuses: site.settings.items.statuses, now, scheduled: true });
		const key = `item.updated:${item.id}:visibility:${new Date(/** @type {number} */ (timeOf(item.nextTransitionAt))).toISOString()}`;
		const next = {
			...item,
			nextTransitionAt: nextTransition(item, now),
			version: (item.version ?? 1) + 1,
			updatedAt: new Date(now),
		};
		const entries = [{ type: EVENT_TYPES.updated, key, changed: [visible ? 'published' : 'unpublished'] }];
		if (!(await site.repos.items.write(next, item.version ?? 1, entries))) return 0;
		await flushItem(deps, site, { ...next, outbox: [...(item.outbox ?? []), ...entries] });
		return 1;
	};

	/** @param {Record<string, any>} item @param {number} now */
	const transitionDue = (item, now) => {
		const at = timeOf(item.nextTransitionAt);
		return at !== null && at <= now;
	};
	/** @param {Record<string, any>} item @param {number} now */
	const outboxStale = (item, now) => {
		const at = timeOf(item.outboxAt);
		return at !== null && at <= now - OUTBOX_GRACE_MS && (item.outbox ?? []).length > 0;
	};

	/**
	 * Due work of the items a request read: their passed transitions and stale outbox entries. Never throws.
	 * @param {Site} site
	 * @param {ReadonlyArray<Record<string, any>>} list stored items
	 */
	const settle = async (site, list) => {
		const now = deps.now();
		let transitions = 0;
		let republished = 0;
		for (const item of list) {
			try {
				if (transitionDue(item, now)) transitions += await transition(site, item);
				else if (outboxStale(item, now)) republished += (await flushItem(deps, site, item)).published;
			} catch (error) {
				deps.log?.warn?.('catalog due work failed', { itemId: item.id, error: /** @type {Error} */ (error)?.message });
			}
		}
		return { transitions, republished };
	};

	/**
	 * Everything due for one website, each step bounded by `limit` (the dashboard's "Process due changes").
	 * @param {Site} site
	 * @param {{ limit?: number }} [options]
	 */
	const runDue = async (site, { limit = DUE_BATCH } = {}) => {
		const now = deps.now();
		let transitions = 0;
		for (const item of await site.repos.items.dueTransitions(new Date(now), limit)) transitions += await transition(site, item);
		const expiredReservations = site.settings.enabled('variants') ? await variants.expire(site, limit) : 0;
		let republished = 0;
		for (const item of await site.repos.items.pendingOutbox(new Date(now - OUTBOX_GRACE_MS), limit))
			republished += (await flushItem(deps, site, item)).published;
		return { transitions, expiredReservations, republished };
	};

	return Object.freeze({ settle, runDue });
};

/** @typedef {ReturnType<typeof createDueWork>} DueWork */
