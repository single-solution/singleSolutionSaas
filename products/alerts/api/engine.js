/**
 * The trigger engine (element `triggers`): one run per change, whatever its source (Event Hub event, API, CSV).
 *
 * 1. `begin` the run under a unique key (`evt:<event id>`, `api:<Idempotency-Key | id>`) — a redelivered event or a
 *    replayed request finds the existing run and does nothing (idempotent consumer, PLAN Part E §9).
 * 2. Fold the change into the target's known state (versioned `items` document) → before / after.
 * 3. Find pending subscriptions of the target in waitlist order (rank, then time), decide with the type rules
 *    (`core/types.js`), and **claim** each one (pending → claimed, compare-and-set on its cycle) before queueing its
 *    alert — a subscription is claimed by at most one run, so it is told once per change even with duplicate deliveries
 *    and concurrent instances.
 * 4. A run that hit the fan-out limit stays `open`; the background pass and the daily job resume it
 *    until every waiter was told.
 * 5. With `dispatch.inline_dispatch` the outbox is run right away (best effort; the background pass after
 *    requests and the daily run catch up).
 * Nothing is claimed while the `dispatch` element is off (e.g. messaging not connected): subscriptions keep waiting.
 */
import { conditionMatches } from '../core/rules.js';
import { DAY_MS, iso } from '../core/time.js';
import { applyChange, emptyItem, stateOf } from '../core/triggers.js';
import { notifyCount } from '../core/priority.js';
import { customType, freeUnits, isId, isTypeEnabled, matchingKeys, shouldFire, targetKeyOf } from '../core/types.js';

/** Days a trigger run is kept. */
const RUN_RETENTION_DAYS = 30;

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/triggers.js').Change} Change */

/**
 * Value at a dotted path of an object.
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
const at = (root, path) =>
	path.split('.').reduce((/** @type {unknown} */ value, part) => {
		if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return undefined;
		return /** @type {Record<string, unknown>} */ (value)[part];
	}, root);

/**
 * Does a custom type listen to an event type? `custom.x` matches every version, `custom.x@2` only version 2.
 * @param {string} listens
 * @param {string} eventType
 */
export const listensTo = (listens, eventType) =>
	listens.includes('@') ? listens === eventType : eventType.split('@')[0] === listens;

/**
 * @param {import('./service.js').Deps & { dispatcher: import('./dispatcher.js').Dispatcher }} deps
 */
export const createEngine = (deps) => {
	const { now, newId, dispatcher, log } = deps;

	/**
	 * Fold a stock / price change into the target's state (optimistic, retried on a concurrent write).
	 * @param {Site} site
	 * @param {Change} change
	 */
	const fold = async (site, change) => {
		const key = targetKeyOf(change.target);
		const options = {
			threshold: site.settings.triggers.threshold,
			locations: site.settings.triggers.locations,
			ignoreOutOfOrder: site.settings.triggers.ignoreOutOfOrder,
		};
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const stored = await site.repos.items.get(key);
			const folded = applyChange(
				stored ? { locations: stored.locations ?? {}, price: stored.price ?? null, priceAt: stored.priceAt ?? 0 } : null,
				change,
				options,
			);
			if (!folded.ok) return folded;
			if (await site.repos.items.save(key, stored?.version ?? 0, folded.next)) return folded;
		}
		return /** @type {const} */ ({ ok: false, reason: 'conflict' });
	};

	/**
	 * Claim and queue the waiters of a target after a change.
	 * @param {Site} site
	 * @param {{ runId: string, targetKeys: string[], types: string[], before: import('../core/types.js').TargetState,
	 *   after: import('../core/types.js').TargetState, decide: (sub: any) => boolean, budgets: Record<string, number | null>,
	 *   item?: { name?: string, url?: string } | null, quantity?: number | null }} input `budgets`: waiters each type may
	 *   still notify (`null` = unlimited)
	 * @returns {Promise<{ matched: number, queued: number, more: boolean, budgets: Record<string, number | null> }>}
	 */
	const claimWaiters = async (site, { runId, targetKeys, types, before, after, decide, budgets, item, quantity }) => {
		const limit = site.settings.triggers.fanoutLimit;
		/** @type {Record<string, number | null>} */
		const left = Object.fromEntries(types.map((type) => [type, budgets[type] ?? null]));
		const open = types.filter((type) => left[type] === null || /** @type {number} */ (left[type]) > 0);
		if (open.length === 0) return { matched: 0, queued: 0, more: false, budgets: left };
		const pending = await site.repos.subscriptions.pendingFor({ targetKeys, types: open, limit });
		let matched = 0;
		let queued = 0;
		for (const sub of pending) {
			const budget = left[sub.type];
			if ((budget !== null && budget !== undefined && budget <= 0) || !decide(sub)) continue;
			matched += 1;
			const claimed = await site.repos.subscriptions.claim(sub.id, sub.cycle ?? 0, runId);
			if (!claimed) continue;
			if (typeof budget === 'number') left[sub.type] = budget - 1;
			if (await dispatcher.queueAlert(site, claimed, { before, after, item: item ?? null, quantity: quantity ?? null }))
				queued += 1;
		}
		const exhausted = types.every((type) => left[type] !== null && /** @type {number} */ (left[type]) <= 0);
		return { matched, queued, more: pending.length >= limit && !exhausted, budgets: left };
	};

	/**
	 * Run the waitlist step for a stock / price change.
	 * @param {Site} site
	 * @param {string} runId
	 * @param {Change} change
	 * @param {import('../core/types.js').TargetState} before
	 * @param {import('../core/types.js').TargetState} after
	 * @param {Record<string, number | null> | null} [budgets] remaining budgets of a resumed run
	 */
	const waitlistStep = (site, runId, change, before, after, budgets = null) => {
		const t = site.settings.types;
		const kinds = change.kind === 'price' ? ['price_drop'] : ['back_in_stock', 'availability', 'price_drop'];
		const types = kinds.filter((type) => isTypeEnabled(type, t));
		const free = freeUnits(after, site.settings.triggers.threshold);
		return claimWaiters(site, {
			runId,
			targetKeys: matchingKeys(change.target),
			types,
			before,
			after,
			decide: (sub) => shouldFire(sub, before, after, t),
			budgets:
				budgets ??
				Object.fromEntries(
					types.map((type) => [type, notifyCount({ type, freeUnits: free, perUnit: t.availabilityPerUnit })]),
				),
			item: change.item ?? null,
			quantity: after.quantity ?? null,
		});
	};

	/**
	 * The custom types a custom event fires, with their targets and budgets.
	 * @param {Site} site
	 * @param {Change} change
	 * @param {{ trusted: boolean }} source
	 */
	const customMatches = (site, change, { trusted }) => {
		const eventType = change.eventType ?? '';
		/** @type {Array<{ type: string, targetKey: string, budget: number | null }>} */
		const out = [];
		for (const definition of site.settings.types.customTypes) {
			if (!isTypeEnabled(customType(definition.key), site.settings.types) || !listensTo(definition.event, eventType)) continue;
			if (!trusted && definition.allow_customer_actor !== true) continue;
			const context = { event: { type: eventType, data: change.data ?? {} }, item: {} };
			if (!conditionMatches(definition.when, context, { now: now(), timeZone: site.settings.dispatch.timeZone }).matched)
				continue;
			const field = definition.target_field ?? '';
			const targetId = field ? at(change.data ?? {}, field) : '*';
			if (!(targetId === '*' || isId(targetId))) continue;
			const capacity = definition.notify === 'capacity' ? at(change.data ?? {}, definition.capacity_field ?? '') : null;
			out.push({
				type: customType(definition.key),
				targetKey: `${targetId}|`,
				budget:
					definition.notify === 'capacity'
						? Number.isSafeInteger(capacity) && /** @type {number} */ (capacity) > 0
							? /** @type {number} */ (capacity)
							: 0
						: null,
			});
		}
		return out;
	};

	/**
	 * Run the waitlist step of a custom event.
	 * @param {Site} site
	 * @param {string} runId
	 * @param {Change} change
	 * @param {boolean} trusted
	 * @param {Record<string, number | null> | null} [budgets] remaining budgets of a resumed run
	 */
	const customStep = async (site, runId, change, trusted, budgets = null) => {
		const matches = customMatches(site, change, { trusted });
		let matched = 0;
		let queued = 0;
		let more = false;
		/** @type {Record<string, number | null>} */
		const left = {};
		for (const match of matches) {
			const out = await claimWaiters(site, {
				runId,
				targetKeys: [match.targetKey],
				types: [match.type],
				before: {},
				after: {},
				decide: () => true,
				budgets: {
					[match.type]: budgets && Object.hasOwn(budgets, match.type) ? (budgets[match.type] ?? null) : match.budget,
				},
				item: change.item ?? null,
			});
			matched += out.matched;
			queued += out.queued;
			more = more || out.more;
			left[match.type] = out.budgets[match.type] ?? null;
		}
		return { types: matches.length, matched, queued, more, budgets: left };
	};

	/**
	 * Process one change.
	 * @param {Site} site
	 * @param {Change} change
	 * @param {{ source: 'event' | 'api' | 'import', key: string, eventId?: string, trusted?: boolean, dispatch?: boolean }} meta
	 * @returns {Promise<Record<string, any>>} the run
	 */
	const process = async (site, change, { source, key, eventId, trusted = true, dispatch = true }) => {
		const runAt = now();
		const begun = await site.repos.triggers.begin(key, {
			id: newId('trg'),
			source,
			kind: change.kind,
			...(eventId ? { eventId } : {}),
			...(change.eventType ? { eventType: change.eventType } : {}),
			...(change.target.itemId === '*' ? {} : { target: change.target }),
			status: 'running',
			at: iso(runAt),
			expiresAt: new Date(runAt + RUN_RETENTION_DAYS * DAY_MS),
		});
		if (!begun.created && begun.run.status !== 'running') return begun.run;
		const runId = begun.run.id;
		const stored =
			change.kind === 'custom'
				? { kind: 'custom', eventType: change.eventType, data: change.data ?? {}, trusted, item: change.item ?? null }
				: { kind: change.kind, target: change.target, item: change.item ?? null };
		/** @type {Record<string, unknown>} */
		let result;
		if (change.kind === 'custom') {
			const out = site.settings.enabled('dispatch')
				? await customStep(site, runId, change, trusted)
				: { types: customMatches(site, change, { trusted }).length, matched: 0, queued: 0, more: false, budgets: {} };
			result = {
				status: out.types > 0 ? 'done' : 'ignored',
				reason: out.types === 0 ? 'no_custom_type' : site.settings.enabled('dispatch') ? null : 'dispatch_disabled',
				matched: out.matched,
				queued: out.queued,
				open: out.more,
				budgets: out.budgets,
			};
		} else {
			const folded = await fold(site, change);
			if (!folded.ok) result = { status: 'ignored', reason: folded.reason, matched: 0, queued: 0, open: false };
			else if (!site.settings.enabled('dispatch'))
				result = {
					status: 'done',
					reason: 'dispatch_disabled',
					before: folded.before,
					after: folded.after,
					matched: 0,
					queued: 0,
					open: false,
				};
			else {
				const out = await waitlistStep(site, runId, change, folded.before, folded.after);
				result = {
					status: 'done',
					reason: null,
					before: folded.before,
					after: folded.after,
					matched: out.matched,
					queued: out.queued,
					open: out.more,
					budgets: out.budgets,
				};
			}
		}
		const run = await site.repos.triggers.finish(key, { ...result, change: stored });
		if (dispatch && Number(result.queued) > 0 && site.settings.dispatch.inline) {
			try {
				await dispatcher.run(site, { limit: Math.min(100, Number(result.queued) + 10) });
			} catch (error) {
				log('warn', 'inline dispatch failed; the scheduled run retries', { websiteId: site.websiteId, error });
			}
		}
		return run;
	};

	/**
	 * Continue open runs (fan-out beyond the per-run limit) with their remaining budgets, while their target is still in
	 * the state that fired them (stock / price runs decide again against the current state).
	 * @param {Site} site
	 * @param {{ limit?: number }} [options]
	 */
	const resume = async (site, { limit = 20 } = {}) => {
		if (!site.settings.enabled('dispatch')) return { resumed: 0, queued: 0 };
		let resumed = 0;
		let queued = 0;
		for (const run of await site.repos.triggers.open(limit)) {
			const change = run.change ?? {};
			/** @type {{ matched: number, queued: number, more: boolean, budgets: Record<string, number | null> }} */
			let out = { matched: 0, queued: 0, more: false, budgets: {} };
			if (change.kind === 'custom')
				out = await customStep(
					site,
					run.id,
					{
						kind: 'custom',
						target: { itemId: '*' },
						eventType: change.eventType,
						data: change.data,
						item: change.item,
						at: now(),
					},
					change.trusted === true,
					run.budgets ?? null,
				);
			else if (change.target) {
				const item = await site.repos.items.get(targetKeyOf(change.target));
				const current = stateOf(item ?? emptyItem(), {
					threshold: site.settings.triggers.threshold,
					locations: site.settings.triggers.locations,
				});
				out = await waitlistStep(
					site,
					run.id,
					{ kind: change.kind, target: change.target, item: change.item, at: now() },
					run.before ?? {},
					current,
					run.budgets ?? null,
				);
			}
			await site.repos.triggers.finish(run.key, {
				open: out.more,
				budgets: out.budgets,
				matched: (run.matched ?? 0) + out.matched,
				queued: (run.queued ?? 0) + out.queued,
			});
			resumed += 1;
			queued += out.queued;
		}
		if (queued > 0 && site.settings.dispatch.inline) await dispatcher.run(site, { limit: Math.min(100, queued + 10) });
		return { resumed, queued };
	};

	return Object.freeze({ process, resume });
};

/** @typedef {ReturnType<typeof createEngine>} Engine */
