/**
 * The loyalty application service: orchestrates `core/` decisions over the `adapters/` repositories for one website at
 * a time. Handlers (REST, events, dashboard, jobs) stay thin and call these functions; every rule lives in `core/`.
 *
 * Exactly-once: every movement has a deterministic `sourceKey` (an event, an Idempotency-Key, a redemption, a job
 * run). The ledger is unique on it, the member journal repairs a ledger write lost to a crash, and the transaction
 * id, the usage record (`point_transaction`) and the published event are all derived from it, so retries converge.
 */
import { evaluateEarn, orderFacts } from '../core/earn.js';
import { expire, scanCutoff, upcomingExpiry, markNoticed } from '../core/lots.js';
import { applyMovement, journalled, newMember, withTier } from '../core/member.js';
import { pointsToValue, quote as quoteFor, redeemProblem } from '../core/redeem.js';
import { attributionRefusal, codeFromBytes, codeFromSource, normaliseCode, rewardDecision } from '../core/referrals.js';
import { collectible, refundedFraction, returnsRedeemed, reversalTarget, spendTarget } from '../core/reversal.js';
import { multiplierOf } from '../core/tiers.js';
import { hasOrderContext, orderSnapshot } from '../core/orders.js';
import { DAY_MS, iso, recentMonthKeys, toMs } from '../core/time.js';
import { memberAsOf, memberView, transactionView } from '../core/views.js';

/** @typedef {import('../core/member.js').Member} Member */
/** @typedef {import('../core/member.js').Movement} Movement */
/** @typedef {import('../core/member.js').Transaction} Transaction */
/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ websiteId: string, settings: Settings, repos: Repositories }} Site */
/** @typedef {{ ok: true, tx: Transaction, member: Member, duplicate: boolean } | { ok: false, reason: string, available?: number }} MoveResult */
/**
 * @typedef {object} ServiceDeps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} [publish]
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string, occurredAt?: string }) => Promise<unknown> | unknown} [recordUsage]
 * @property {(entry: { websiteId: string, actor: { type: string, id?: string }, action: string, target?: Record<string, unknown>, after?: unknown }) => Promise<unknown>} [audit]
 * @property {(text: string) => string} hash stable 26-char id material from a key
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {() => number} [now]
 */

/** Optimistic-concurrency attempts before a movement gives up with `conflict`. */
const MAX_ATTEMPTS = 8;
/** Members handled per page by the jobs. */
const JOB_PAGE = 200;
/** Codes tried before a referral code is given up as colliding. */
const CODE_ATTEMPTS = 5;

/** Published event types. */
export const EVENTS = Object.freeze({
	earned: 'loyalty.earned@1',
	redeemed: 'loyalty.redeemed@1',
	tierChanged: 'loyalty.tier_changed@1',
	expiring: 'loyalty.expiring@1',
});

/** Unit metered per stored point transaction. */
export const METERED_UNIT = 'point_transaction';

/**
 * @param {ServiceDeps} deps
 */
export const createLoyaltyService = ({
	publish = async () => {},
	recordUsage = () => {},
	audit = async () => {},
	hash,
	randomBytes,
	now = Date.now,
}) => {
	/** @param {string} websiteId @param {string} key */
	const txIdFor = (websiteId, key) => `ptx_${hash(`${websiteId}|${key}`)}`;

	/**
	 * Publish best effort (the movement is stored either way; the Portal dedupes on the idempotency key).
	 * @param {Parameters<NonNullable<ServiceDeps['publish']>>[0]} event
	 */
	const emit = async (event) => {
		try {
			await publish(event);
		} catch {
			// an unreachable Event Hub never fails a movement
		}
	};

	/**
	 * Side effects of a stored movement: metering and events. Each is idempotent on the transaction id.
	 * @param {Site} site
	 * @param {Transaction} tx
	 * @param {{ from: string | null, to: string | null, direction: 'up' | 'down', metric: number } | null} tierChange
	 * @param {Member} member
	 */
	const effects = async (site, tx, tierChange, member) => {
		if (tx.points !== 0)
			await recordUsage({
				websiteId: site.websiteId,
				unit: METERED_UNIT,
				quantity: 1,
				idempotencyKey: `pt:${tx.id}`,
				occurredAt: tx.occurredAt,
			});
		if (tx.points > 0 && (tx.kind === 'earn' || tx.kind === 'referral' || tx.kind === 'adjust')) {
			await emit({
				websiteId: site.websiteId,
				type: EVENTS.earned,
				idempotencyKey: `earned:${tx.id}`,
				data: {
					customerId: tx.customerId,
					transactionId: tx.id,
					kind: tx.kind,
					points: tx.points,
					balance: tx.balanceAfter,
					...(typeof tx.source.orderId === 'string' ? { orderId: tx.source.orderId } : {}),
					...(Array.isArray(tx.source.ruleIds) ? { ruleIds: tx.source.ruleIds } : {}),
					...(typeof tx.source.eventId === 'string' ? { sourceEventId: tx.source.eventId } : {}),
				},
			});
		}
		if (tierChange) {
			await emit({
				websiteId: site.websiteId,
				type: EVENTS.tierChanged,
				idempotencyKey: `tier:${tx.id}`,
				data: { customerId: tx.customerId, ...tierChange, reviewAt: member.tier?.reviewAt ?? null },
			});
		}
	};

	/**
	 * Source key of expiring a member's lapsed lots (shared by the job, the background sweep and expire-on-access, so they
	 * converge on one transaction).
	 * @param {string} customerId
	 * @param {import('../core/lots.js').Slice[]} slices
	 */
	const expireKey = (customerId, slices) =>
		`expire:${customerId}:${slices
			.map((slice) => slice.lotId)
			.sort()
			.join(',')}`;

	/**
	 * Lots of `member` past their expiry at `at` (none when expiry is off).
	 * @param {Site} site
	 * @param {Member} member
	 * @param {number} at
	 */
	const lapsedOf = (site, member, at) =>
		site.settings.expiry ? expire({ lots: member.lots, debt: member.debt }, at, site.settings.expiry) : null;

	/**
	 * Expire-on-access: book the expiry of a member's lapsed lots now (the same transaction the job would write), so
	 * expired points are never spendable or shown, whether or not a job ran. Returns the member as it is now.
	 * @param {Site} site
	 * @param {Member | null} member
	 * @param {number} [at]
	 * @returns {Promise<Member | null>}
	 */
	const settle = async (site, member, at = now()) => {
		const lapsed = member ? lapsedOf(site, member, at) : null;
		if (!member || !lapsed || lapsed.expired <= 0) return member;
		const result = await move(site, {
			customerId: member.customerId,
			sourceKey: expireKey(member.customerId, lapsed.slices),
			build: () => ({ kind: 'expire', points: 0, at, source: { type: 'expiry' }, reason: 'points_expired' }),
		});
		return result.ok ? result.member : memberAsOf(member, { now: at, expiry: site.settings.expiry });
	};

	/**
	 * Apply one movement exactly once for `sourceKey`. Lots that lapsed are expired first (expire-on-access).
	 * @param {Site} site
	 * @param {{ customerId: string, sourceKey: string, build: (member: Member) => (Omit<Movement, 'txId' | 'sourceKey'> & { patch?: Partial<Member> }) | { skip: string } }} input
	 * @returns {Promise<MoveResult | { ok: false, reason: 'skipped', detail: string }>}
	 */
	const move = async (site, { customerId, sourceKey, build }) => {
		const { repos, settings } = site;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const stored = /** @type {Transaction | null} */ (await repos.transactions.bySourceKey(sourceKey));
			if (stored)
				return {
					ok: true,
					tx: stored,
					member: (await repos.members.get(customerId)) ?? newMember(customerId, now()),
					duplicate: true,
				};
			const current = await repos.members.get(customerId);
			const member = current ?? newMember(customerId, now());
			const prior = journalled(member, sourceKey);
			if (prior) {
				// the member moved but the ledger write was lost: repair it (effects are idempotent)
				await effects(site, prior, null, member);
				await repos.transactions.append(prior);
				return { ok: true, tx: prior, member, duplicate: true };
			}
			const built = build(member);
			if ('skip' in built) return { ok: false, reason: 'skipped', detail: built.skip };
			if (built.kind !== 'expire' && (lapsedOf(site, member, now())?.expired ?? 0) > 0) {
				await settle(site, member);
				continue;
			}
			const { patch, ...movement } = built;
			const applied = applyMovement(
				member,
				{ ...movement, txId: txIdFor(site.websiteId, sourceKey), sourceKey },
				{ timeZone: settings.timeZone, tierWindowMonths: settings.tiers?.window_months ?? 0, expiry: settings.expiry },
			);
			if (!applied.ok) return applied;
			const tiered = withTier({ ...applied.member, ...(patch ?? {}) }, settings.tiers, {
				now: movement.at,
				timeZone: settings.timeZone,
			});
			const saved = current
				? await repos.members.save(member.version, tiered.member)
				: await repos.members.insert(tiered.member);
			if (!saved) continue;
			await effects(site, applied.tx, tiered.change, tiered.member);
			await repos.transactions.append(applied.tx);
			return { ok: true, tx: applied.tx, member: { ...tiered.member, version: member.version + 1 }, duplicate: false };
		}
		return { ok: false, reason: 'conflict' };
	};

	/**
	 * Change a member without moving points (codes, attribution, tier reviews), optimistic like `move`.
	 * @param {Site} site
	 * @param {string} customerId
	 * @param {(member: Member) => Partial<Member> | null} change null = nothing to do
	 * @returns {Promise<Member | null>}
	 */
	const mutate = async (site, customerId, change) => {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const current = await site.repos.members.get(customerId);
			const member = current ?? newMember(customerId, now());
			const patch = change(member);
			if (patch === null) return current;
			const next = { ...member, ...patch };
			const saved = current ? await site.repos.members.save(member.version, next) : await site.repos.members.insert(next);
			if (saved) return { ...next, version: member.version + 1 };
		}
		return null;
	};

	/**
	 * Earn context shared by every rule.
	 * @param {Member} member
	 * @param {Settings} settings
	 * @param {{ type: string, data: Record<string, unknown>, occurredAt: string }} event
	 */
	const contextFor = (member, settings, event) => ({
		event,
		customer: {
			id: member.customerId,
			orders: member.orders,
			balance: member.balance,
			lifetimeEarned: member.lifetime.earned,
			lifetimeSpend: member.lifetime.spend,
			joinedAt: member.joinedAt,
			tier: member.tier?.key ?? null,
		},
		tier: {
			key: member.tier?.key ?? null,
			multiplier: settings.tiers ? multiplierOf(settings.tiers.tiers, member.tier?.key) : 1,
		},
	});

	/**
	 * Evaluate the earn rules for an event and credit the result once per `sourceKey`.
	 * @param {Site} site
	 * @param {{ customerId: string, type: string, data: Record<string, unknown>, at: number, sourceKey: string,
	 *   order?: import('../core/earn.js').OrderSnapshot | null, eventId?: string, completion?: { spend: number } }} input
	 */
	const earnFor = async (site, { customerId, type, data, at, sourceKey, order = null, eventId, completion }) => {
		const { settings } = site;
		return move(site, {
			customerId,
			sourceKey,
			build: (member) => {
				const context = contextFor(member, settings, { type, data, occurredAt: iso(at) });
				const result = settings.enabled('earn_rules')
					? evaluateEarn({
							rules: settings.rules,
							type,
							context,
							multiplier: context.tier.multiplier,
							rounding: settings.earn.rounding,
							usage: member.ruleUsage,
							now: at,
							timeZone: settings.timeZone,
							maxPoints: settings.earn.max_points_per_transaction,
							...(order ? { orderFactsFor: (rule) => orderFacts(order, rule.exclusions) } : {}),
						})
					: { total: 0, earnings: [], usage: member.ruleUsage };
				const spend = completion?.spend ?? 0;
				if (result.total <= 0 && !completion) return { skip: 'no_points' };
				const source = {
					type,
					...(eventId ? { eventId } : {}),
					...(order ? { orderId: order.orderId } : {}),
					ruleIds: result.earnings.map((earning) => earning.ruleId),
				};
				return {
					kind: result.total > 0 ? 'earn' : 'record',
					points: result.total,
					at,
					ruleUsage: result.usage,
					qualifying: { points: result.total, spend },
					lifetimeSpend: spend,
					ordersDelta: completion ? 1 : 0,
					source,
					reason: result.total > 0 ? 'earn_rules' : 'order_completed',
				};
			},
		});
	};

	// ── referrals ──────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Attribute a new customer to a referral code.
	 * @param {Site} site
	 * @param {{ code: string, customerId: string, at?: number }} input
	 * @returns {Promise<{ ok: true, referral: Record<string, unknown> } | { ok: false, reason: string }>}
	 */
	const attribute = async (site, { code, customerId, at = now() }) => {
		const config = site.settings.referrals;
		if (!config) return { ok: false, reason: 'referrals_disabled' };
		const referrer = await site.repos.members.byReferralCode(normaliseCode(code));
		const existing = await site.repos.referrals.byReferee(customerId);
		const referee = await site.repos.members.get(customerId);
		const refusal = attributionRefusal({
			referrerId: referrer?.customerId ?? null,
			refereeId: customerId,
			alreadyReferred: existing !== null,
			refereeOrders: referee?.orders ?? 0,
			config,
		});
		if (refusal) return { ok: false, reason: refusal };
		const referral = {
			refereeId: customerId,
			referrerId: /** @type {Member} */ (referrer).customerId,
			code: normaliseCode(code),
			status: 'pending',
			attributedAt: iso(at),
			rewardedAt: null,
			reason: null,
		};
		if (!(await site.repos.referrals.insert(referral))) return { ok: false, reason: 'already_referred' };
		await mutate(site, customerId, (member) => (member.referredBy ? null : { referredBy: referral.referrerId }));
		return { ok: true, referral };
	};

	/**
	 * On a completed order: reward a pending referral of the customer (first qualifying order only).
	 * @param {Site} site
	 * @param {{ customerId: string, orderAmount: number, at: number }} input
	 */
	const rewardReferral = async (site, { customerId, orderAmount, at }) => {
		const config = site.settings.referrals;
		if (!config) return null;
		const referral = await site.repos.referrals.byReferee(customerId);
		if (!referral || referral.status !== 'pending') return null;
		const monthStart = iso(at - 30 * DAY_MS);
		const decision = rewardDecision({
			attributedAt: referral.attributedAt,
			now: at,
			orderAmount,
			referrerRewardsThisMonth: await site.repos.referrals.countRewarded(referral.referrerId, monthStart),
			referrerRewardsTotal: await site.repos.referrals.countRewarded(referral.referrerId),
			config,
		});
		if (decision.decision === 'wait') return decision;
		const status = decision.decision === 'expired' ? 'expired' : decision.referrer > 0 ? 'rewarded' : 'capped';
		if (!(await site.repos.referrals.close(customerId, { status, rewardedAt: iso(at), reason: decision.reason }))) return null;
		const source = { type: 'referral', referrerId: referral.referrerId, refereeId: customerId };
		if (decision.referee > 0)
			await move(site, {
				customerId,
				sourceKey: `referral:referee:${customerId}`,
				build: () => ({
					kind: 'referral',
					points: decision.referee,
					at,
					qualifying: { points: decision.referee },
					source,
					reason: 'referee_reward',
				}),
			});
		if (decision.referrer > 0)
			await move(site, {
				customerId: referral.referrerId,
				sourceKey: `referral:referrer:${customerId}`,
				build: () => ({
					kind: 'referral',
					points: decision.referrer,
					at,
					qualifying: { points: decision.referrer },
					source,
					reason: 'referrer_reward',
				}),
			});
		return decision;
	};

	// ── redemptions ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Give a redemption's points back once (release at checkout, or refund of a cancelled order).
	 * @param {Site} site
	 * @param {Record<string, any>} redemption
	 * @param {'released' | 'refunded'} status
	 * @param {number} at
	 */
	const giveBack = async (site, redemption, status, at) => {
		const redeemTx = /** @type {Transaction | null} */ (await site.repos.transactions.bySourceKey(`redeem:${redemption.id}`));
		const result = await move(site, {
			customerId: redemption.customerId,
			sourceKey: `return:${redemption.id}`,
			build: () => ({
				kind: 'return',
				points: redemption.points,
				at,
				slices: redeemTx?.slices ?? [],
				source: {
					type: 'redemption',
					redemptionId: redemption.id,
					...(redemption.orderId ? { orderId: redemption.orderId } : {}),
				},
				reason: status === 'released' ? 'redemption_released' : 'redemption_refunded',
			}),
		});
		if (result.ok) await site.repos.redemptions.transition(redemption.id, ['applied'], { status, returnedAt: iso(at) });
		return result;
	};

	// ── order reversal ─────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Give redeemed points back when the order is fully undone, then reverse earned points of the order up to
	 * `fraction` (and its spend in the tier metric). Each step is first claimed on the order (compare-and-set), then executed as
	 * a movement keyed by the claimed total, so concurrent or repeated deliveries never reverse more than the target.
	 * @param {Site} site
	 * @param {Record<string, any>} order stored order (snapshot may be null)
	 * @param {{ fraction: number, at: number }} input
	 */
	const reverseOrder = async (site, order, { fraction, at }) => {
		const config = site.settings.reversal;
		if (!config) return { reversed: 0, returned: 0 };
		// redeemed points come back first, so the reversal can then take back what the order earned
		let returned = 0;
		if (returnsRedeemed({ fraction, config })) {
			for (const redemption of await site.repos.redemptions.byOrder(order.orderId)) {
				if (redemption?.status !== 'applied') continue;
				const result = await giveBack(site, redemption, 'refunded', at);
				if (result.ok) returned += result.tx.points;
			}
		}
		const customerId = order.snapshot?.customerId;
		let reversed = 0;
		if (typeof customerId === 'string') {
			const sums = await site.repos.transactions.sumsForOrder(order.orderId);
			const target = reversalTarget({ earned: Math.max(0, sums.earn ?? 0), fraction, config });
			const spend = spendTarget({ total: order.snapshot?.amounts?.total ?? 0, fraction, config });
			let current = order;
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const from = current.reversedTo ?? 0;
				const spendFrom = current.reversedSpend ?? 0;
				if (target <= from && spend <= spendFrom) break;
				const claim = { from, to: Math.max(from, target), spendFrom, spendTo: Math.max(spendFrom, spend), at: iso(at) };
				if (await site.repos.orders.claimReversal(order.orderId, claim)) break;
				current = (await site.repos.orders.get(order.orderId)) ?? current;
			}
			const claims = /** @type {Array<{ from: number, to: number, spendFrom: number, spendTo: number }>} */ (
				((await site.repos.orders.get(order.orderId)) ?? current).reversals ?? []
			);
			const earnedAt = toMs(order.completedAt ?? order.placedAt ?? iso(at));
			const prefer = ['order.completed@1', 'order.placed@1'].map((type) =>
				txIdFor(site.websiteId, `earn:${type}:${order.orderId}`),
			);
			for (const claim of claims) {
				const result = await move(site, {
					customerId,
					sourceKey: `reverse:${order.orderId}:${claim.to}:${claim.spendTo}`,
					build: (member) => {
						const { points, allowNegative } = collectible({ due: claim.to - claim.from, balance: member.balance, config });
						const spendDelta = claim.spendTo - claim.spendFrom;
						if (points <= 0 && spendDelta <= 0) return { skip: 'nothing_to_reverse' };
						return {
							kind: points > 0 ? 'reverse' : 'record',
							points,
							at,
							allowNegative,
							prefer,
							qualifying: { points: -points, spend: -spendDelta, at: earnedAt },
							lifetimeSpend: -spendDelta,
							source: { type: 'reversal', orderId: order.orderId, fraction },
							reason: fraction >= 1 ? 'order_reversed' : 'order_partially_refunded',
						};
					},
				});
				if (result.ok && !result.duplicate) reversed += -result.tx.points;
			}
		}
		return { reversed, returned };
	};

	/**
	 * Earn on completion (+ spend toward tiers, + referral reward).
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {number} at
	 * @param {string} eventId
	 */
	const completeOrder = async (site, order, at, eventId) => {
		const snapshot = order.snapshot;
		if (!snapshot?.customerId) return { pending: false, earned: null, referral: null };
		const earned = await earnFor(site, {
			customerId: snapshot.customerId,
			type: 'order.completed@1',
			data: { orderId: snapshot.orderId },
			at,
			sourceKey: `earn:order.completed@1:${snapshot.orderId}`,
			order: snapshot,
			eventId,
			completion: { spend: snapshot.amounts?.total ?? 0 },
		});
		const referral = await rewardReferral(site, {
			customerId: snapshot.customerId,
			orderAmount: snapshot.amounts?.total ?? 0,
			at,
		});
		return { pending: false, earned, referral };
	};

	// ── public API ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * @param {Site} site
	 * @param {Member} member
	 */
	const view = (site, member) =>
		memberView(member, {
			tiers: site.settings.tiers,
			now: now(),
			timeZone: site.settings.timeZone,
			expiringWindowDays: site.settings.wallet.expiring_window_days,
			expiry: site.settings.expiry,
		});

	return Object.freeze({
		txIdFor,
		view,
		move,

		/**
		 * A member as it is now (lapsed lots are expired on access).
		 * @param {Site} site
		 * @param {string} customerId
		 */
		member: async (site, customerId) => settle(site, await site.repos.members.get(customerId)),

		/**
		 * @param {Site} site
		 * @param {{ customerId?: string, after?: string | null, fetchLimit: number }} page
		 */
		history: async (site, page) =>
			(await site.repos.transactions.list(page))
				.filter((/** @type {Transaction} */ tx) => tx.points !== 0)
				.map(transactionView),

		/**
		 * Manual / API earn of a number of points.
		 * @param {Site} site
		 * @param {{ customerId: string, points: number, reason?: string, reference?: string, key: string, actor?: { type: string, id?: string } }} input
		 */
		earn: async (site, { customerId, points, reason, reference, key, actor }) =>
			move(site, {
				customerId,
				sourceKey: `earn:api:${reference ?? key}`,
				build: () => ({
					kind: 'earn',
					points,
					at: now(),
					qualifying: { points },
					source: { type: 'api', ...(reference ? { reference } : {}) },
					reason: reason ?? 'api',
					actor: actor ?? null,
				}),
			}),

		/**
		 * A custom event (`custom.<name>@v`) evaluated against the earn rules.
		 * @param {Site} site
		 * @param {{ id: string, type: string, customerId: string, data?: Record<string, unknown> }} input
		 */
		activity: async (site, { id, type, customerId, data = {} }) =>
			earnFor(site, { customerId, type, data, at: now(), sourceKey: `earn:${type}:${id}`, eventId: id }),

		/**
		 * `order.placed@1`: keep the snapshot (lines, amounts, customer) for completion, refunds and rules.
		 * @param {Site} site
		 * @param {{ id: string, occurredAt: string, data: Record<string, any> }} event
		 */
		orderPlaced: async (site, event) => {
			const data = event.data;
			const at = toMs(event.occurredAt);
			const snapshot = orderSnapshot(data, event.occurredAt);
			const order = await site.repos.orders.recordPlaced(snapshot);
			if (!snapshot.customerId) return { order, earned: null };
			const placed = await earnFor(site, {
				customerId: snapshot.customerId,
				type: 'order.placed@1',
				data,
				at,
				sourceKey: `earn:order.placed@1:${snapshot.orderId}`,
				order: snapshot,
				eventId: event.id,
			});
			// the completion arrived first: settle it now that the order is known
			if (order?.completedAt)
				await completeOrder(site, /** @type {Record<string, any>} */ (order), toMs(order.completedAt), event.id);
			return { order, earned: placed };
		},

		/**
		 * `order.completed@1`: earn on completion (spend counts toward tiers), reward referrals.
		 * @param {Site} site
		 * @param {{ id: string, occurredAt: string, data: { orderId: string } }} event
		 */
		orderCompleted: async (site, event) => {
			let order = await site.repos.orders.mark(event.data.orderId, 'completedAt', event.occurredAt);
			// contracts v1 (additive): a completion may carry the order context itself (lines, amounts, customer)
			if (!order?.snapshot && hasOrderContext(event.data))
				order = await site.repos.orders.recordPlaced(orderSnapshot(event.data, event.occurredAt));
			if (!order?.snapshot) return { pending: true };
			return completeOrder(site, order, toMs(event.occurredAt), event.id);
		},

		/**
		 * `order.cancelled@1`: reverse everything earned, give redeemed points back.
		 * @param {Site} site
		 * @param {{ id: string, occurredAt: string, data: { orderId: string } }} event
		 */
		orderCancelled: async (site, event) => {
			const order = await site.repos.orders.mark(event.data.orderId, 'cancelledAt', event.occurredAt);
			if (!order) return { reversed: 0, returned: 0 };
			return reverseOrder(site, order, { fraction: 1, at: toMs(event.occurredAt) });
		},

		/**
		 * `order.refunded@1`: reverse in proportion to the refunded amount (cumulative over refunds).
		 * @param {Site} site
		 * @param {{ id: string, occurredAt: string, data: { orderId: string, amount: { amount: number } } }} event
		 */
		orderRefunded: async (site, event) => {
			const order = await site.repos.orders.addRefund(event.data.orderId, {
				eventId: event.id,
				amount: event.data.amount.amount,
				at: event.occurredAt,
			});
			if (!order) return { reversed: 0, returned: 0 };
			const refunded = (order.refunds ?? []).reduce(
				(/** @type {number} */ sum, /** @type {{ amount: number }} */ r) => sum + r.amount,
				0,
			);
			const fraction = refundedFraction({ refunded, total: order.snapshot?.amounts?.total ?? 0 });
			return reverseOrder(site, order, { fraction, at: toMs(event.occurredAt) });
		},

		/**
		 * `custom.*` events delivered by the Event Hub (`events.consumes: custom.*`): the same earn rules as
		 * `POST /v1/activities`, keyed by the event id (a delivery and an API call with that id earn once). The customer
		 * is `data.customerId`, else the event's customer actor; events without one are ignored.
		 * @param {Site} site
		 * @param {{ id: string, type: string, actor?: { type: string, id?: string }, data: Record<string, any> }} event
		 */
		customEvent: async (site, event) => {
			const customerId =
				typeof event.data?.customerId === 'string'
					? event.data.customerId
					: event.actor?.type === 'customer' && typeof event.actor.id === 'string'
						? event.actor.id
						: null;
			if (!customerId) return { ok: false, reason: 'skipped' };
			return earnFor(site, {
				customerId,
				type: event.type,
				data: event.data ?? {},
				at: now(),
				sourceKey: `earn:${event.type}:${event.id}`,
				eventId: event.id,
			});
		},

		/**
		 * `customer.created@1`: create the member, attribute a referral from `data.source`, welcome rules.
		 * @param {Site} site
		 * @param {{ id: string, occurredAt: string, data: { customerId: string, source?: string } }} event
		 */
		customerCreated: async (site, event) => {
			const { customerId } = event.data;
			const at = toMs(event.occurredAt);
			await mutate(site, customerId, (member) => (member.version > 0 ? null : { joinedAt: iso(at) }));
			const code = site.settings.referrals ? codeFromSource(event.data.source, site.settings.referrals.source_prefix) : null;
			const referral = code ? await attribute(site, { code, customerId, at }) : null;
			const earned = await earnFor(site, {
				customerId,
				type: 'customer.created@1',
				data: event.data,
				at,
				sourceKey: `earn:customer.created@1:${customerId}`,
				eventId: event.id,
			});
			return { referral, earned };
		},

		/**
		 * @param {Site} site
		 * @param {{ customerId: string, amount: number, currency: string, discount?: number }} input
		 */
		quote: async (site, { customerId, amount, currency, discount = 0 }) => {
			const member = await settle(site, await site.repos.members.get(customerId));
			const q = quoteFor({ balance: member?.balance ?? 0, amount, discount, config: site.settings.redeem });
			return {
				customerId,
				currency,
				amount,
				...q,
				pointValue: { points: site.settings.redeem.rate_points, value: site.settings.redeem.rate_value_minor },
			};
		},

		/**
		 * Redeem points at a checkout (idempotent on `key`).
		 * @param {Site} site
		 * @param {{ customerId: string, points: number, amount: number, currency: string, discount?: number, orderId?: string, reference?: string, key: string }} input
		 * @returns {Promise<{ ok: true, redemption: Record<string, any> } | { ok: false, reason: string }>}
		 */
		redeem: async (site, input) => {
			const id = `red_${hash(`${site.websiteId}|${input.reference ?? input.key}`)}`;
			const existing = await site.repos.redemptions.get(id);
			if (existing) return { ok: true, redemption: existing };
			const at = now();
			/** @type {string | null} */
			let problem = null;
			const result = await move(site, {
				customerId: input.customerId,
				sourceKey: `redeem:${id}`,
				build: (member) => {
					const q = quoteFor({
						balance: member.balance,
						amount: input.amount,
						discount: input.discount ?? 0,
						config: site.settings.redeem,
					});
					problem = redeemProblem(input.points, q);
					if (problem) return { skip: problem };
					return {
						kind: 'redeem',
						points: input.points,
						at,
						source: { type: 'redemption', redemptionId: id, ...(input.orderId ? { orderId: input.orderId } : {}) },
						reason: 'checkout',
					};
				},
			});
			if (!result.ok) return { ok: false, reason: problem ?? ('detail' in result ? result.detail : result.reason) };
			const redemption = {
				id,
				customerId: input.customerId,
				status: 'applied',
				points: -result.tx.points,
				valueAmount: pointsToValue(-result.tx.points, site.settings.redeem),
				currency: input.currency,
				amount: input.amount,
				orderId: input.orderId ?? null,
				reference: input.reference ?? null,
				balanceAfter: result.tx.balanceAfter,
				returnedAt: null,
			};
			await site.repos.redemptions.insert(redemption);
			const stored = /** @type {Record<string, any>} */ ((await site.repos.redemptions.get(id)) ?? redemption);
			await emit({
				websiteId: site.websiteId,
				type: EVENTS.redeemed,
				idempotencyKey: `redeemed:${id}`,
				data: {
					customerId: stored.customerId,
					redemptionId: id,
					points: stored.points,
					valueAmount: stored.valueAmount,
					currency: stored.currency,
					balance: stored.balanceAfter,
					...(stored.orderId ? { orderId: stored.orderId } : {}),
				},
			});
			return { ok: true, redemption: stored };
		},

		/** @param {Site} site @param {string} id */
		redemption: async (site, id) => site.repos.redemptions.get(id),

		/**
		 * Release an applied redemption (abandoned checkout): the points go back to their original lots.
		 * @param {Site} site
		 * @param {string} id
		 * @returns {Promise<{ ok: true, redemption: Record<string, any> } | { ok: false, reason: string }>}
		 */
		release: async (site, id) => {
			const redemption = await site.repos.redemptions.get(id);
			if (!redemption) return { ok: false, reason: 'not_found' };
			if (redemption.status === 'applied') {
				const result = await giveBack(site, redemption, 'released', now());
				if (!result.ok) return { ok: false, reason: result.reason };
			} else if (redemption.status !== 'released') return { ok: false, reason: 'not_releasable' };
			return { ok: true, redemption: /** @type {Record<string, any>} */ (await site.repos.redemptions.get(id)) };
		},

		/**
		 * Attach the order to a redemption made before the order existed (so cancellations give the points back).
		 * @param {Site} site
		 * @param {string} id
		 * @param {string} orderId
		 * @returns {Promise<{ ok: true, redemption: Record<string, any> } | { ok: false, reason: string }>}
		 */
		confirm: async (site, id, orderId) => {
			const redemption = await site.repos.redemptions.get(id);
			if (!redemption) return { ok: false, reason: 'not_found' };
			if (redemption.orderId && redemption.orderId !== orderId) return { ok: false, reason: 'order_mismatch' };
			if (redemption.status !== 'applied') return { ok: false, reason: 'not_applied' };
			await site.repos.redemptions.transition(id, ['applied'], { orderId });
			return { ok: true, redemption: /** @type {Record<string, any>} */ (await site.repos.redemptions.get(id)) };
		},

		/**
		 * Manual credit (points > 0) or debit (points < 0) with a reason code (audited).
		 * @param {Site} site
		 * @param {{ customerId: string, points: number, reason: string, note?: string, key: string, actor: { type: string, id?: string } }} input
		 */
		adjust: async (site, { customerId, points, reason, note, key, actor }) => {
			const result = await move(site, {
				customerId,
				sourceKey: `adjust:${key}`,
				build: () => ({
					kind: 'adjust',
					points,
					at: now(),
					allowNegative: site.settings.adjustments.allow_negative === true,
					source: { type: 'adjustment' },
					reason,
					note: note ?? null,
					actor,
				}),
			});
			if (result.ok && !result.duplicate)
				await audit({
					websiteId: site.websiteId,
					actor,
					action: 'loyalty.adjustment',
					target: { customerId },
					after: { points, reason, note: note ?? null, transactionId: result.tx.id },
				});
			return result;
		},

		/**
		 * The member's referral code (created once, unique per website).
		 * @param {Site} site
		 * @param {string} customerId
		 * @returns {Promise<{ ok: true, code: string } | { ok: false, reason: string }>}
		 */
		referralCode: async (site, customerId) => {
			const config = site.settings.referrals;
			if (!config) return { ok: false, reason: 'referrals_disabled' };
			for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
				const code = codeFromBytes({
					prefix: config.code_prefix,
					length: config.code_length,
					bytes: randomBytes(config.code_length),
				});
				try {
					const member = await mutate(site, customerId, (current) => (current.referralCode ? null : { referralCode: code }));
					const stored = member?.referralCode ?? (await site.repos.members.get(customerId))?.referralCode;
					if (stored) return { ok: true, code: stored };
				} catch (error) {
					if (/** @type {{ code?: number }} */ (error)?.code !== 11000) throw error; // code collision: try another
				}
			}
			return { ok: false, reason: 'conflict' };
		},

		attribute,

		/**
		 * Expiry work for one website (the daily job, and the throttled background task with a `deadline`): expire lots
		 * (FIFO), publish expiry notices, review tiers. Idempotent, so a run cut short by its deadline is simply continued
		 * by the next one.
		 * @param {Site} site
		 * @param {{ at?: number, deadline?: number }} [options]
		 */
		runExpiry: async (site, { at = now(), deadline = Infinity } = {}) => {
			const { settings, repos } = site;
			const stats = { expired: 0, members: 0, notices: 0, tierReviews: 0 };
			if (settings.expiry) {
				const policy = settings.expiry;
				const noticeMs = policy.noticeDays * DAY_MS;
				// members holding a lot old enough to expire now, or within the notice window
				const until = iso(scanCutoff(at + noticeMs, policy));
				let after = /** @type {string | null} */ (null);
				for (;;) {
					const page = await repos.members.withLotsEarnedBy(until, { after, limit: JOB_PAGE });
					for (const member of page) {
						const expired = expire({ lots: member.lots, debt: member.debt }, at, policy);
						if (expired.expired > 0) {
							const result = await move(site, {
								customerId: member.customerId,
								sourceKey: expireKey(member.customerId, expired.slices),
								build: () => ({ kind: 'expire', points: 0, at, source: { type: 'expiry' }, reason: 'points_expired' }),
							});
							if (result.ok && !result.duplicate) {
								stats.expired += -result.tx.points;
								stats.members += 1;
							}
						}
						if (noticeMs > 0) {
							const fresh = (await repos.members.get(member.customerId)) ?? member;
							const next = upcomingExpiry(
								{ lots: fresh.lots, debt: fresh.debt },
								{ now: at, windowMs: noticeMs, timeZone: settings.timeZone, policy },
							);
							if (
								next &&
								fresh.lots.some(
									(/** @type {import('../core/lots.js').Lot} */ lot) =>
										next.lotIds.includes(lot.id) && lot.noticeFor !== next.expiresOn,
								)
							) {
								const updated = await mutate(site, member.customerId, (current) => {
									if (!current.lots.some((lot) => next.lotIds.includes(lot.id) && lot.noticeFor !== next.expiresOn))
										return null;
									return markNoticed({ lots: current.lots, debt: current.debt }, next.lotIds, next.expiresOn);
								});
								if (updated) {
									stats.notices += 1;
									await emit({
										websiteId: site.websiteId,
										type: EVENTS.expiring,
										idempotencyKey: `expiring:${member.customerId}:${next.expiresOn}`,
										data: {
											customerId: member.customerId,
											points: next.points,
											expiresAt: next.expiresAt,
											expiresOn: next.expiresOn,
											balance: updated.balance,
										},
									});
								}
							}
						}
					}
					if (page.length < JOB_PAGE || now() >= deadline) break;
					after = /** @type {Member} */ (page.at(-1)).customerId;
				}
			}
			if (settings.tiers) {
				let after = /** @type {string | null} */ (null);
				for (;;) {
					const page = await repos.members.dueForTierReview(iso(at), { after, limit: JOB_PAGE });
					for (const member of page) {
						const tiered = withTier(member, settings.tiers, { now: at, timeZone: settings.timeZone });
						if (tiered.member.tier === member.tier) continue;
						const saved = await repos.members.save(member.version, tiered.member);
						if (!saved) continue;
						stats.tierReviews += 1;
						if (tiered.change)
							await emit({
								websiteId: site.websiteId,
								type: EVENTS.tierChanged,
								idempotencyKey: `tier:${member.customerId}:review:${iso(at).slice(0, 10)}`,
								data: { customerId: member.customerId, ...tiered.change, reviewAt: tiered.member.tier?.reviewAt ?? null },
							});
					}
					if (page.length < JOB_PAGE || now() >= deadline) break;
					after = /** @type {Member} */ (page.at(-1)).customerId;
				}
			}
			return stats;
		},

		/**
		 * KPIs of the dashboard overview.
		 * @param {Site} site
		 */
		overview: async (site) => {
			const at = now();
			const [members, totals, applied] = await Promise.all([
				site.repos.members.stats(),
				site.repos.transactions.totalsSince(iso(at - 30 * DAY_MS)),
				site.repos.redemptions.countApplied(),
			]);
			return {
				members: members.count,
				outstandingPoints: members.outstanding,
				last30Days: {
					earned: (totals.earn?.points ?? 0) + (totals.referral?.points ?? 0),
					redeemed: -(totals.redeem?.points ?? 0) - (totals.return?.points ?? 0),
					expired: -(totals.expire?.points ?? 0),
					reversed: -(totals.reverse?.points ?? 0),
					transactions: Object.values(totals).reduce((sum, row) => sum + row.count, 0),
				},
				activeRedemptions: applied,
				months: recentMonthKeys(at, 1, site.settings.timeZone),
			};
		},
	});
};

/** @typedef {ReturnType<typeof createLoyaltyService>} LoyaltyService */
