/**
 * Hourly settlement and the money safety rules that follow it. Settlement runs when a merchant's money is read or a
 * product reports for one of its websites (`money.settleDue`, F.19: no cron), and on demand (admin operation).
 *
 * Per subscription, from its cursor (`settledThrough`) to the last complete hour (minus a short lag so in-flight usage
 * of the hour lands first): `planSettlement` + `planMeteredSettlement` from `@ss/entitlements` produce one entry per
 * hour (`<sub>:<hour>`, zero amounts included) and one metered entry per hour with usage (`<sub>:<hour>:metered`).
 * Entries are appended with their `periodKey` as a unique key, so any re-run — overlapping reads and operations, a crash after N
 * inserts, a manual force — settles every hour exactly once; the cursor only moves after the append succeeded.
 *
 * After a merchant's subscriptions are settled: balance ≤ 0 pauses all of them (`insufficient_credits`), a positive
 * balance releases that hold; the merchant's monthly spend cap is evaluated with the next hours' burn (`spend_cap`
 * hold until the UTC month ends or the cap is raised or removed).
 * @module
 */
import { createId } from '@ss/contracts';
import { HOUR_MS, ceilHour, floorHour, periodBounds, planSettlement, spendCapDecision } from '@ss/entitlements';
import { SPEND_LOOKAHEAD_HOURS, bookOrThrow, meteredDraft, settlementDraft, subscriptionBurn } from '../core/billing.js';
import { settlementCatalog, unitPeriod } from '../core/catalog.js';
import { CHARGE_TYPES } from '../core/ledger.js';
import { pauseReasonOf, pinAt, runsNextHour, timelineEvents } from '../core/subscription.js';
import { SYSTEM_ACTOR } from './subscriptions.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./ledger.js').Ledger} Ledger */
/** @typedef {import('./subscriptions.js').Subscriptions} Subscriptions */
/** @typedef {Record<string, any>} Doc */

/** Usage of an hour is settled once the hour has been over for this long. */
export const SETTLEMENT_LAG_MS = 2 * 60_000;
/** At most this many hours per subscription per pass (a longer catch-up continues in the next pass). */
export const MAX_HOURS_PER_PASS = 24 * 35;
const BATCH = 50;
const DEADLINE_MARGIN_MS = 5_000;

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, ledger: Ledger, subscriptions: Subscriptions }} input
 */
export const createSettlement = ({ ctx, repo, deps, ledger, subscriptions }) => {
	/**
	 * @param {{ kind: string, merchantId?: string | null, subscriptionId?: string | null, details?: unknown }} alert
	 */
	const raiseAlert = async ({ kind, merchantId = null, subscriptionId = null, details = null }) => {
		await repo.insertAlert({
			_id: createId('alr', { randomBytes: ctx.randomBytes }),
			at: new Date(ctx.now()),
			kind,
			merchantId,
			subscriptionId,
			details,
		});
		ctx.logger.warn('commerce alert', { kind, merchantId, subscriptionId });
	};

	/**
	 * Products of every manifest version a subscription was pinned to, and its settlement catalog.
	 * @param {Doc} sub
	 */
	const catalogFor = async (sub) => {
		/** @type {(string | number)[]} */
		const versions = [...new Set(sub.pins.map((/** @type {Doc} */ p) => p.manifestVersion))];
		const loaded = await Promise.all(versions.map((v) => deps.manifestOf(sub.appId, v)));
		/** @type {Map<string, import('../core/catalog.js').Product>} */
		const products = new Map(versions.map((v, i) => [String(v), /** @type {any} */ (loaded[i]).product]));
		return { catalog: settlementCatalog(loaded.map((l) => l.manifest)), products };
	};

	/**
	 * The settlement plan of `[from, to)` for a subscription (pure inputs read from storage).
	 * @param {Doc} sub @param {number} from @param {number} to
	 */
	const planFor = async (sub, from, to) => {
		const { catalog, products } = await catalogFor(sub);
		const [snapshots, pauses] = await Promise.all([
			repo.timelineWindow(sub.merchantId, sub._id, new Date(from), new Date(to)),
			repo.pausesOverlapping(sub.merchantId, sub._id, new Date(from), new Date(to)),
		]);
		const plan = planSettlement({
			subscription: {
				id: sub._id,
				startedAt: new Date(sub.startedAt).toISOString(),
				endedAt: sub.endedAt ? new Date(sub.endedAt).toISOString() : null,
				pins: sub.pins.map((/** @type {Doc} */ p) => ({ version: p.version, at: new Date(p.at).toISOString() })),
			},
			priceBook: catalog,
			elementTimeline: timelineEvents(/** @type {any[]} */ (snapshots)),
			pauses: pauses.map((p) => ({ from: p.from, to: p.to ?? null, reason: pauseReasonOf(p.reason) })),
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
		});
		return { plan, catalog, products };
	};

	/**
	 * Settle one subscription up to `target` (epoch ms, hour-aligned).
	 * @param {Doc} sub @param {number} target
	 * @returns {Promise<{ entries: number, duplicates: number, hours: number }>}
	 */
	const settleSubscription = async (sub, target) => {
		const from = new Date(sub.settledThrough).getTime();
		const end = sub.endedAt ? Math.min(target, ceilHour(new Date(sub.endedAt).getTime())) : target;
		const to = Math.min(end, from + MAX_HOURS_PER_PASS * HOUR_MS);
		const finalEnd = sub.endedAt ? ceilHour(new Date(sub.endedAt).getTime()) : null;
		if (to <= from) {
			if (finalEnd !== null && from >= finalEnd) await repo.advanceCursor(sub, new Date(from), true);
			return { entries: 0, duplicates: 0, hours: 0 };
		}
		const { plan, catalog, products } = await planFor(sub, from, to);
		const unpriced = plan.skipped.filter((s) => s.reason === 'unpriced');
		if (unpriced.length > 0)
			await raiseAlert({
				kind: 'unpriced_hours',
				merchantId: sub.merchantId,
				subscriptionId: sub._id,
				details: { periodKeys: unpriced.map((s) => s.periodKey) },
			});
		/** @type {import('../core/ledger.js').EntryDraft[]} */
		const drafts = [];
		const timeZone = (await deps.getWebsite(sub.websiteId)).timeZone ?? 'UTC';
		for (const bucket of plan.buckets) {
			drafts.push(settlementDraft(/** @type {any} */ (sub), bucket));
			const hour = new Date(bucket.bucketStart);
			const quantities = await repo.usageInBucket(sub.merchantId, sub._id, hour);
			const used = Object.entries(quantities).filter(([, q]) => q > 0);
			if (used.length === 0) continue;
			for (const [unit, quantity] of used) await repo.setCounter(sub.merchantId, sub._id, unit, hour, quantity);
			const pin = pinAt(sub.pins, hour);
			const product = /** @type {import('../core/catalog.js').Product} */ (products.get(String(pin.manifestVersion)));
			/** @type {Record<string, number>} */
			const before = {};
			for (const [unit] of used) {
				const period = periodBounds({ unit: unitPeriod(product, unit), timeZone, at: hour.getTime() });
				const sums = await repo.countersBetween(sub.merchantId, sub._id, [unit], new Date(period.start), hour);
				before[unit] = sums[unit] ?? 0;
			}
			const metered = meteredDraft({
				sub: /** @type {any} */ (sub),
				bucket,
				book: bookOrThrow(catalog, bucket.priceBookVersion),
				planCode: pin.planCode ?? null,
				quantities: Object.fromEntries(used),
				before,
			});
			if (metered) drafts.push(metered);
		}
		const result = drafts.length > 0 ? await ledger.append(sub.merchantId, drafts) : { appended: [], duplicates: [] };
		const cursor = new Date(plan.cursor).getTime();
		await repo.advanceCursor(sub, new Date(cursor), finalEnd !== null && cursor >= finalEnd);
		return {
			entries: result.appended.length,
			duplicates: result.duplicates.length,
			hours: plan.buckets.length + plan.skipped.length,
		};
	};

	/**
	 * Balance rules after money moved: ≤ 0 pauses every subscription, > 0 releases the insufficient-credits hold.
	 * @param {string} merchantId
	 */
	const applyBalanceRules = async (merchantId) => {
		const balance = await ledger.balance(merchantId);
		if (balance <= 0)
			return {
				balance,
				paused: await subscriptions.setHoldForMerchant(merchantId, 'insufficient_credits', true, 'insufficient_credits'),
				resumed: 0,
			};
		return {
			balance,
			paused: 0,
			resumed: await subscriptions.setHoldForMerchant(merchantId, 'insufficient_credits', false, 'credits_available'),
		};
	};

	/**
	 * Next-hour burn of a live subscription (0 when it will not run).
	 * @param {Doc} sub @param {number} now @param {{ ignoreSpendCap?: boolean }} [options]
	 */
	const burnOf = async (sub, now, options = {}) => {
		if (!runsNextHour(sub, options)) return 0;
		const { catalog } = await catalogFor(sub);
		const last = await repo.lastTimeline(sub.merchantId, sub._id);
		return subscriptionBurn({
			product: catalog,
			pins: sub.pins,
			startedAt: sub.startedAt,
			elements: last?.elements ?? [],
			at: now,
		});
	};

	/**
	 * Charges of the merchant's current UTC month as spend entries (`amount` positive).
	 * @param {string} merchantId @param {number} now
	 * @returns {Promise<{ at: Date, amount: number }[]>}
	 */
	const monthCharges = async (merchantId, now) => {
		const d = new Date(now);
		const charges = await repo
			.ledgerOf(merchantId)
			.find(
				{
					merchantId,
					type: { $in: [...CHARGE_TYPES] },
					periodStart: { $gte: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) },
				},
				{ projection: { amount: 1, periodStart: 1 } },
			)
			.toArray();
		return charges.map((e) => ({ at: e.periodStart, amount: -e.amount || 0 }));
	};

	/**
	 * Evaluate the merchant's monthly spend cap and add/release the `spend_cap` hold on its live subscriptions. It pauses
	 * when the month's spend plus {@link SPEND_LOOKAHEAD_HOURS} of the merchant's burn would exceed the cap, until the
	 * month ends.
	 * @param {string} merchantId
	 */
	const evaluateSpend = async (merchantId) => {
		const subs = await repo.subscriptionsOfMerchant(merchantId, { live: true });
		const cap = await repo.spendCapOf(merchantId);
		const now = ctx.now();
		/** @type {{ shouldPause: boolean, resumeAt: string | null }} */
		let decision = { shouldPause: false, resumeAt: null };
		if (cap) {
			let burn = 0;
			for (const sub of subs) burn += await burnOf(sub, now, { ignoreSpendCap: true });
			decision = spendCapDecision({
				cap: { limit: cap.limit },
				entries: await monthCharges(merchantId, now),
				now,
				upcoming: SPEND_LOOKAHEAD_HOURS * burn,
			});
		}
		let paused = 0;
		for (const sub of subs) {
			if (decision.shouldPause && !sub.holds.includes('spend_cap')) paused += 1;
			await subscriptions.setHold(sub, 'spend_cap', decision.shouldPause, {
				actor: SYSTEM_ACTOR,
				reason: cap ? 'spend_cap' : 'spend_cap_removed',
				resumeAt: decision.resumeAt,
			});
		}
		return { paused };
	};

	/**
	 * Settle due subscriptions in (merchant, id) order until done or the deadline approaches (the `settlement` admin
	 * operation), or for one merchant (`merchantId`) on read, with a short deadline and no margin — then its money rules
	 * are applied even when no hour was due (a spend-cap window may have reset). Idempotent: every hour is appended
	 * under its unique `periodKey`.
	 * @param {{ deadline?: number, signal?: AbortSignal, merchantId?: string | null, marginMs?: number,
	 *   logger?: import('../../../infra/logger.js').Logger }} [options] `marginMs` = stop this long before `deadline`
	 */
	const runSettlement = async ({
		deadline = Number.POSITIVE_INFINITY,
		signal,
		merchantId = null,
		marginMs = DEADLINE_MARGIN_MS,
	} = {}) => {
		const target = floorHour(ctx.now() - SETTLEMENT_LAG_MS);
		const stats = { subscriptions: 0, entries: 0, duplicates: 0, failures: 0, merchants: 0, complete: true };
		const timeUp = () => signal?.aborted === true || ctx.now() > deadline - marginMs;
		/** @type {{ merchantId: string, id: string } | null} */
		let after = null;
		/** @type {string | null} */
		let current = null;
		const finishMerchant = async (/** @type {string} */ id) => {
			stats.merchants += 1;
			try {
				await applyBalanceRules(id);
				await evaluateSpend(id);
			} catch (error) {
				stats.failures += 1;
				ctx.logger.error('merchant money rules failed', { merchantId: id, error });
			}
		};
		for (;;) {
			if (timeUp()) {
				stats.complete = false;
				break;
			}
			const batch = await repo.dueForSettlement({ target: new Date(target), after, merchantId, limit: BATCH });
			if (batch.length === 0) break;
			for (const sub of batch) {
				if (timeUp()) {
					stats.complete = false;
					break;
				}
				if (current !== null && current !== sub.merchantId) await finishMerchant(current);
				current = sub.merchantId;
				try {
					const out = await settleSubscription(sub, target);
					stats.subscriptions += 1;
					stats.entries += out.entries;
					stats.duplicates += out.duplicates;
				} catch (error) {
					stats.failures += 1;
					ctx.logger.error('subscription settlement failed', { subscriptionId: sub._id, error });
				}
				after = { merchantId: sub.merchantId, id: sub._id };
			}
			if (!stats.complete) break;
		}
		if (current !== null) await finishMerchant(current);
		else if (merchantId !== null && stats.complete) await finishMerchant(merchantId);
		return stats;
	};

	return Object.freeze({
		runSettlement,
		settleSubscription,
		planFor,
		applyBalanceRules,
		evaluateSpend,
		monthCharges,
		burnOf,
		raiseAlert,
		catalogFor,
	});
};
/** @typedef {ReturnType<typeof createSettlement>} Settlement */
