import { describe, expect, it } from 'vitest';
import { applyMovement, journalled, JOURNAL_SIZE, newMember, normaliseMember, withTier } from '../core/member.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { DAY_MS } from '../core/time.js';
import { expiringView, memberView, redemptionView, tierView, transactionView } from '../core/views.js';

const t0 = Date.parse('2026-10-01T10:00:00Z');
const options = { timeZone: 'UTC', tierWindowMonths: 12, expiry: { months: 12 } };
/** @type {any} */
const tierConfig = {
	tiers: [
		{ key: 'bronze', name: 'Bronze', threshold: 0, multiplier: 1 },
		{ key: 'silver', name: 'Silver', threshold: 100, multiplier: 1.25, perks: { free_shipping: true } },
	],
	basis: 'points_earned',
	window_months: 12,
	downgrade: 'immediate',
};
/** @param {any} member @param {any} movement */
const apply = (member, movement) => {
	const result = applyMovement(member, { txId: `ptx_${movement.sourceKey}`, at: t0, ...movement }, options);
	if (!result.ok) throw new Error(result.reason);
	return result;
};

describe('applyMovement', () => {
	it('credits, debits and keeps balance, lifetime totals, buckets and the journal together', () => {
		let { member, tx } = apply(newMember('cus_1', t0), {
			kind: 'earn',
			points: 150,
			sourceKey: 'a',
			qualifying: { points: 150, spend: 9000 },
			lifetimeSpend: 9000,
			ordersDelta: 1,
			source: { orderId: 'o1' },
		});
		expect(tx).toMatchObject({
			id: 'ptx_a',
			kind: 'earn',
			points: 150,
			balanceAfter: 150,
			lotId: 'ptx_a',
			occurredAt: '2026-10-01T10:00:00.000Z',
		});
		expect(member).toMatchObject({
			balance: 150,
			orders: 1,
			lifetime: { earned: 150, spend: 9000, points: 150 },
			buckets: { '2026-10': { points: 150, spend: 9000 } },
		});
		({ member, tx } = apply(member, { kind: 'redeem', points: 50, sourceKey: 'b' }));
		expect(tx).toMatchObject({ points: -50, balanceAfter: 100, slices: [{ lotId: 'ptx_a', points: 50 }] });
		expect(member.lifetime.redeemed).toBe(50);
		({ member, tx } = apply(member, { kind: 'return', points: 50, sourceKey: 'c', slices: tx.slices }));
		expect(member).toMatchObject({ balance: 150, lifetime: { redeemed: 0 } });
		({ member } = apply(member, {
			kind: 'reverse',
			points: 30,
			sourceKey: 'd',
			prefer: ['ptx_a'],
			qualifying: { points: -30 },
		}));
		expect(member).toMatchObject({ balance: 120, lifetime: { earned: 120, points: 120 } });
		({ member, tx } = apply(member, { kind: 'adjust', points: -20, sourceKey: 'e' }));
		expect(tx.points).toBe(-20);
		({ member, tx } = apply(member, { kind: 'adjust', points: 5, sourceKey: 'f' }));
		expect(tx).toMatchObject({ points: 5, kind: 'adjust' });
		({ member, tx } = apply(member, {
			kind: 'record',
			points: 0,
			sourceKey: 'g',
			qualifying: { spend: 100 },
			lifetimeSpend: 100,
			ordersDelta: 1,
		}));
		expect(tx.points).toBe(0);
		expect(member.orders).toBe(2);
		expect(member.journal.map((entry) => entry.sourceKey)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
		expect(journalled(member, 'd')?.kind).toBe('reverse');
		expect(journalled(member, 'zz')).toBeNull();
	});

	it('refuses invalid movements and overdrafts; allows negative when asked', () => {
		const member = newMember('cus_1', t0);
		expect(applyMovement(member, { kind: 'earn', points: 0, txId: 'x', sourceKey: 'x', at: t0 }, options)).toEqual({
			ok: false,
			reason: 'points_invalid',
		});
		expect(applyMovement(member, { kind: 'redeem', points: 5, txId: 'x', sourceKey: 'x', at: t0 }, options)).toEqual({
			ok: false,
			reason: 'insufficient_points',
			available: 0,
		});
		expect(applyMovement(member, { kind: 'expire', points: 0, txId: 'x', sourceKey: 'x', at: t0 }, options)).toEqual({
			ok: false,
			reason: 'nothing_expired',
		});
		expect(
			applyMovement(member, { kind: 'return', points: 0, txId: 'x', sourceKey: 'x', at: t0, slices: [] }, options),
		).toEqual({ ok: false, reason: 'points_invalid' });
		const negative = applyMovement(
			member,
			{ kind: 'reverse', points: 40, txId: 'x', sourceKey: 'x', at: t0, allowNegative: true },
			options,
		);
		expect(negative.ok && negative.member).toMatchObject({ balance: -40, debt: 40 });
	});

	it('expires lots by policy and trims the journal', () => {
		let { member } = apply(newMember('cus_1', t0), { kind: 'earn', points: 10, sourceKey: 'old', at: t0 - 400 * DAY_MS });
		const expired = applyMovement(member, { kind: 'expire', points: 0, txId: 'e', sourceKey: 'exp', at: t0 }, options);
		expect(expired.ok && expired.tx).toMatchObject({ points: -10, balanceAfter: 0, slices: [{ lotId: 'ptx_old' }] });
		for (let i = 0; i < JOURNAL_SIZE + 5; i += 1) ({ member } = apply(member, { kind: 'earn', points: 1, sourceKey: `k${i}` }));
		expect(member.journal).toHaveLength(JOURNAL_SIZE);
		expect(member.journal[0]?.sourceKey).toBe('k5');
	});

	it('normalises older documents', () => {
		const member = normaliseMember(/** @type {any} */ ({ customerId: 'cus_1', balance: 5, lifetime: { earned: 5 } }), t0);
		expect(member).toMatchObject({ debt: 0, lots: [], journal: [], version: 0, lifetime: { earned: 5, redeemed: 0 } });
	});
});

describe('withTier and views', () => {
	it('upgrades on qualifying points and reports the change', () => {
		const { member } = apply(newMember('cus_1', t0), {
			kind: 'earn',
			points: 120,
			sourceKey: 'a',
			qualifying: { points: 120 },
		});
		const tiered = withTier(member, tierConfig, { now: t0, timeZone: 'UTC' });
		expect(tiered.change).toEqual({ from: null, to: 'silver', direction: 'up', metric: 120 });
		expect(withTier(tiered.member, tierConfig, { now: t0, timeZone: 'UTC' }).change).toBeNull();
		expect(withTier(member, null, { now: t0, timeZone: 'UTC' })).toEqual({ member, change: null });
		const view = tierView(tiered.member, tierConfig, { now: t0, timeZone: 'UTC' });
		expect(view).toMatchObject({
			key: 'silver',
			name: 'Silver',
			multiplier: 1.25,
			perks: { free_shipping: true },
			metric: 120,
			next: null,
		});
		expect(tierView(tiered.member, null, { now: t0, timeZone: 'UTC' })).toBeNull();
		const lowView = tierView(newMember('x', t0), tierConfig, { now: t0, timeZone: 'UTC' });
		expect(lowView).toMatchObject({ key: null, next: { key: 'silver', remaining: 100 } });
	});

	it('builds public member, transaction and redemption views', () => {
		const { member, tx } = apply(newMember('cus_1', t0), {
			kind: 'earn',
			points: 10,
			sourceKey: 'a',
			at: t0 - 350 * DAY_MS,
			source: { orderId: 'o1', ruleIds: ['r'] },
		});
		const view = memberView(member, { tiers: null, now: t0, timeZone: 'UTC', expiringWindowDays: 30, expiry: { months: 12 } });
		expect(view).toMatchObject({
			customerId: 'cus_1',
			balance: 10,
			tier: null,
			expiring: { points: 10, expiresOn: '2026-10-16' },
		});
		expect(Object.keys(view)).not.toContain('journal');
		expect(memberView(member, { tiers: null, now: t0, timeZone: 'UTC' }).expiring).toBeNull();
		expect(expiringView(member, { now: t0, timeZone: 'UTC', days: 30, expiry: null })).toBeNull();
		expect(transactionView(tx)).toMatchObject({ id: 'ptx_a', orderId: 'o1', ruleIds: ['r'] });
		expect(transactionView({ ...tx, source: {} })).toMatchObject({ orderId: null, ruleIds: [] });
		const createdAt = new Date(t0);
		expect(
			redemptionView({
				id: 'red_1',
				customerId: 'c',
				status: 'applied',
				points: 5,
				valueAmount: 5,
				currency: 'USD',
				balanceAfter: 0,
				createdAt,
			}),
		).toMatchObject({ createdAt: '2026-10-01T10:00:00.000Z', orderId: null, reference: null, returnedAt: null });
		expect(redemptionView({ id: 'red_1', createdAt: 'x' }).createdAt).toBe('x');
	});
});

describe('effective configuration', () => {
	const schema = {
		properties: {
			a: { type: 'integer', default: 3 },
			b: { type: 'array', default: ['x'] },
			c: { type: 'object', default: { k: 1 } },
			d: { type: 'number', default: 1.5 },
			e: { type: 'boolean', default: true },
			f: { type: 'string', default: 's' },
			g: { default: 'any' },
		},
	};
	it('overlays typed values on schema defaults, dropping mistyped ones', () => {
		expect(defaultsOf(schema)).toEqual({ a: 3, b: ['x'], c: { k: 1 }, d: 1.5, e: true, f: 's', g: 'any' });
		expect(defaultsOf({})).toEqual({});
		expect(effectiveConfig(schema, { a: 4, b: 'no', c: [], d: Number.NaN, e: false, f: 't', g: 0, z: 1 })).toEqual({
			a: 4,
			b: ['x'],
			c: { k: 1 },
			d: 1.5,
			e: false,
			f: 't',
			g: 0,
		});
		expect(effectiveConfig(schema, { a: 2.5 }).a).toBe(3);
		expect(effectiveConfig(schema, null).a).toBe(3);
	});
});
