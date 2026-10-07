/**
 * A member's points state and how movements change it (pure). The member document is the unit of consistency: every
 * movement is computed here from the current document and written back with an optimistic version check, so balance,
 * lots, debt, tier buckets, cap usage and the journal always move together (no multi-document transactions needed —
 * standalone MongoDB works too).
 *
 * The **journal** keeps the last movements on the member document. The ledger (`transactions`) is append-only and
 * written after the member update; if a process dies in between, the next attempt with the same `sourceKey` finds the
 * entry in the journal and repairs the ledger instead of moving points twice (exactly once per source event).
 * @module
 */
import { balanceOf, credit, debit, expire, restore } from './lots.js';
import { addToBucket, decideTier, pruneBuckets, tierMetric } from './tiers.js';
import { iso, monthKey } from './time.js';

export const MEMBER_SCHEMA_VERSION = 1;
/** Movements kept on the member document for exactly-once repair. */
export const JOURNAL_SIZE = 50;

/** Movement kinds and their direction. */
export const MOVEMENT_KINDS = Object.freeze({
	earn: 'credit',
	referral: 'credit',
	return: 'credit',
	redeem: 'debit',
	reverse: 'debit',
	expire: 'debit',
	adjust: 'signed',
	record: 'none',
});

/** @typedef {keyof typeof MOVEMENT_KINDS} MovementKind */
/** @typedef {import('./lots.js').Lot} Lot */
/** @typedef {import('./lots.js').Slice} Slice */
/**
 * @typedef {object} Member
 * @property {string} customerId
 * @property {number} balance
 * @property {number} debt
 * @property {Lot[]} lots
 * @property {{ earned: number, redeemed: number, spend: number, points: number }} lifetime `points` = tier-qualifying points
 * @property {import('./tiers.js').Buckets} buckets
 * @property {import('./earn.js').RuleUsage} ruleUsage
 * @property {import('./tiers.js').MemberTier | null} tier
 * @property {number} orders completed orders
 * @property {string} joinedAt
 * @property {string | null} referralCode
 * @property {string | null} referredBy
 * @property {Transaction[]} journal
 * @property {number} version
 */
/**
 * @typedef {object} Transaction
 * @property {string} id
 * @property {string} customerId
 * @property {MovementKind} kind
 * @property {number} points signed delta
 * @property {number} balanceAfter
 * @property {string} sourceKey idempotency key of the source (event, request, job)
 * @property {Record<string, unknown>} source
 * @property {string | null} reason
 * @property {string | null} note
 * @property {string} occurredAt
 * @property {Slice[]} slices lots consumed (debits) or restored (returns)
 * @property {string | null} lotId lot opened by a credit
 * @property {{ type: string, id?: string } | null} actor
 */
/**
 * @typedef {object} Movement
 * @property {MovementKind} kind
 * @property {number} points magnitude (adjust: signed)
 * @property {string} txId
 * @property {string} sourceKey
 * @property {number} at
 * @property {string[]} [prefer] debits: lots consumed first
 * @property {boolean} [allowNegative] debits
 * @property {Slice[]} [slices] returns: what to restore
 * @property {{ points?: number, spend?: number, at?: number }} [qualifying] tier metric delta (month of `at`, default the movement)
 * @property {number} [lifetimeSpend] completed spend delta
 * @property {import('./earn.js').RuleUsage} [ruleUsage] replaces the cap usage
 * @property {number} [ordersDelta]
 * @property {Record<string, unknown>} [source]
 * @property {string | null} [reason]
 * @property {string | null} [note]
 * @property {{ type: string, id?: string } | null} [actor]
 */

/**
 * A new member.
 * @param {string} customerId
 * @param {number} at
 * @returns {Member}
 */
export const newMember = (customerId, at) => ({
	customerId,
	balance: 0,
	debt: 0,
	lots: [],
	lifetime: { earned: 0, redeemed: 0, spend: 0, points: 0 },
	buckets: {},
	ruleUsage: {},
	tier: null,
	orders: 0,
	joinedAt: iso(at),
	referralCode: null,
	referredBy: null,
	journal: [],
	version: 0,
});

/**
 * Fill fields missing from an older document (lazy migration helper).
 * @param {Partial<Member> & { customerId: string }} doc
 * @param {number} at
 * @returns {Member}
 */
export const normaliseMember = (doc, at) => {
	const base = newMember(doc.customerId, at);
	return {
		...base,
		...doc,
		lifetime: { ...base.lifetime, ...(doc.lifetime ?? {}) },
		buckets: doc.buckets ?? {},
		ruleUsage: doc.ruleUsage ?? {},
		lots: doc.lots ?? [],
		journal: doc.journal ?? [],
		debt: doc.debt ?? 0,
		version: doc.version ?? 0,
	};
};

/**
 * The journal entry for a source key, if this member already applied it.
 * @param {Member} member
 * @param {string} sourceKey
 * @returns {Transaction | null}
 */
export const journalled = (member, sourceKey) => member.journal.find((tx) => tx.sourceKey === sourceKey) ?? null;

/**
 * Apply one movement.
 * `record` changes no points: it records a completed order's spend (tier metric, order count) exactly once.
 * @param {Member} member
 * @param {Movement} movement
 * @param {{ timeZone: string, tierWindowMonths?: number, expiry?: import('./lots.js').ExpiryPolicy | null }} options
 * @returns {{ ok: true, member: Member, tx: Transaction } | { ok: false, reason: string, available?: number }}
 */
export const applyMovement = (member, movement, { timeZone, tierWindowMonths = 0, expiry = null }) => {
	const state = { lots: member.lots, debt: member.debt };
	const magnitude = Math.abs(Math.trunc(movement.points));
	const direction =
		MOVEMENT_KINDS[movement.kind] === 'signed' ? (movement.points < 0 ? 'debit' : 'credit') : MOVEMENT_KINDS[movement.kind];
	if (!(magnitude > 0) && movement.kind !== 'expire' && movement.kind !== 'record')
		return { ok: false, reason: 'points_invalid' };
	/** @type {import('./lots.js').PointState} */
	let next = state;
	/** @type {Slice[]} */
	let slices = [];
	/** @type {string | null} */
	let lotId = null;
	let delta = 0;
	if (movement.kind === 'record') {
		delta = 0;
	} else if (movement.kind === 'expire') {
		const expired = expire(state, movement.at, expiry);
		if (expired.expired <= 0) return { ok: false, reason: 'nothing_expired' };
		next = expired.state;
		slices = expired.slices;
		delta = -expired.expired;
	} else if (movement.kind === 'return') {
		const restored = restore(state, movement.slices ?? []);
		next = restored.state;
		slices = movement.slices ?? [];
		delta = restored.restored;
		if (delta <= 0) return { ok: false, reason: 'points_invalid' };
	} else if (direction === 'credit') {
		const result = credit(state, { id: movement.txId, points: magnitude, at: movement.at });
		next = result.state;
		lotId = result.lot?.id ?? null;
		delta = magnitude;
	} else {
		const result = debit(state, {
			points: magnitude,
			prefer: movement.prefer ?? [],
			allowNegative: movement.allowNegative === true,
		});
		if (!result.ok) return { ok: false, reason: result.reason, available: result.available };
		next = result.state;
		slices = result.consumed;
		delta = -magnitude;
	}
	const balance = balanceOf(next);
	let buckets = member.buckets;
	const qualifying = movement.qualifying;
	if (qualifying && (qualifying.points || qualifying.spend)) {
		buckets = addToBucket(buckets, monthKey(qualifying.at ?? movement.at, timeZone), qualifying);
	}
	buckets = pruneBuckets(buckets, { now: movement.at, months: tierWindowMonths, timeZone });
	/** @type {Transaction} */
	const tx = {
		id: movement.txId,
		customerId: member.customerId,
		kind: movement.kind,
		points: delta,
		balanceAfter: balance,
		sourceKey: movement.sourceKey,
		source: movement.source ?? {},
		reason: movement.reason ?? null,
		note: movement.note ?? null,
		occurredAt: iso(movement.at),
		slices,
		lotId,
		actor: movement.actor ?? null,
	};
	const earnedDelta = movement.kind === 'earn' || movement.kind === 'referral' ? delta : movement.kind === 'reverse' ? delta : 0;
	const redeemedDelta = movement.kind === 'redeem' ? magnitude : movement.kind === 'return' ? -delta : 0;
	return {
		ok: true,
		tx,
		member: {
			...member,
			lots: next.lots,
			debt: next.debt,
			balance,
			lifetime: {
				earned: member.lifetime.earned + earnedDelta,
				redeemed: member.lifetime.redeemed + redeemedDelta,
				spend: member.lifetime.spend + (movement.lifetimeSpend ?? 0),
				points: member.lifetime.points + (qualifying?.points ?? 0),
			},
			buckets,
			ruleUsage: movement.ruleUsage ?? member.ruleUsage,
			orders: member.orders + (movement.ordersDelta ?? 0),
			journal: [...member.journal, tx].slice(-JOURNAL_SIZE),
		},
	};
};

/**
 * Re-evaluate the tier (no-op without a tier configuration).
 * @param {Member} member
 * @param {import('./tiers.js').TierConfig | null} config
 * @param {{ now: number, timeZone: string }} at
 * @returns {{ member: Member, change: { from: string | null, to: string | null, direction: 'up' | 'down', metric: number } | null }}
 */
export const withTier = (member, config, { now, timeZone }) => {
	if (!config || config.tiers.length === 0) return { member, change: null };
	const metric = tierMetric(
		{ buckets: member.buckets, lifetime: { points: member.lifetime.points, spend: member.lifetime.spend } },
		config,
		{
			now,
			timeZone,
		},
	);
	const decided = decideTier({ current: member.tier, metric, config, now });
	const updated = { ...member, tier: decided.tier };
	return {
		member: updated,
		change:
			decided.changed && decided.direction
				? { from: member.tier?.key ?? null, to: decided.tier?.key ?? null, direction: decided.direction, metric }
				: null,
	};
};
