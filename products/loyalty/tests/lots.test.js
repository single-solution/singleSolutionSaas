/**
 * FIFO lots and expiry. The `ledgerExpiry` / `replayLedger` cases are ported one-to-one from ibrahimMobiles
 * `loyaltyExpiry.test.ts`; the rest extend them (debt, preferred lots, restore, notices, time zones).
 */
import { describe, expect, it } from 'vitest';
import {
	balanceOf,
	credit,
	debit,
	emptyState,
	entryDelta,
	expire,
	expiryOf,
	ledgerExpiry,
	markNoticed,
	replayLedger,
	restore,
	scanCutoff,
	upcomingExpiry,
} from '../core/lots.js';
import { DAY_MS } from '../core/time.js';

const at = (/** @type {any} */ iso) => Date.parse(iso);
const tx = (/** @type {any} */ kind, /** @type {any} */ amount, /** @type {any} */ occurredAt) => ({ kind, amount, occurredAt });
const balanceOfLedger = (/** @type {any} */ entries) =>
	entries.reduce((/** @type {any} */ sum, /** @type {any} */ entry) => sum + entryDelta(entry), 0);
const six = { months: 6 };

describe('entryDelta (ibrahimMobiles loyaltyTransactionDelta)', () => {
	it('treats earn/bonus as credits and redeem/expire as debits regardless of stored sign', () => {
		expect(entryDelta({ kind: 'earn', amount: 50 })).toBe(50);
		expect(entryDelta({ kind: 'bonus', amount: -20 })).toBe(20);
		expect(entryDelta({ kind: 'redeem', amount: 30 })).toBe(-30);
		expect(entryDelta({ kind: 'redeem', amount: -30 })).toBe(-30);
		expect(entryDelta({ kind: 'expire', amount: 10 })).toBe(-10);
		expect(entryDelta({ kind: 'earn', amount: Number.NaN })).toBe(0);
	});
	it('keeps adjust signed', () => {
		expect(entryDelta({ kind: 'adjust', amount: 15 })).toBe(15);
		expect(entryDelta({ kind: 'adjust', amount: -15 })).toBe(-15);
	});
});

describe('ledgerExpiry (ibrahimMobiles computeLoyaltyExpiry)', () => {
	const now = at('2026-09-30T12:00:00Z');

	it('expires lots older than the window', () => {
		const ledger = [tx('earn', 100, '2026-01-10T00:00:00Z'), tx('earn', 40, '2026-08-01T00:00:00Z')];
		const result = ledgerExpiry(ledger, six, now, balanceOfLedger(ledger));
		expect(result.expiredPoints).toBe(100);
		expect(result.newestExpiredCreditAt).toBe('2026-01-10T00:00:00.000Z');
		expect(scanCutoff(now, six)).toBeGreaterThanOrEqual(at('2026-01-10T00:00:00Z'));
	});

	it('expires exactly at the boundary', () => {
		const ledger = [tx('earn', 25, '2026-03-30T12:00:00Z')];
		expect(ledgerExpiry(ledger, six, now, 25).expiredPoints).toBe(25);
		expect(ledgerExpiry(ledger, six, at('2026-09-30T11:59:59Z'), 25).expiredPoints).toBe(0);
	});

	it('lets redemptions consume the oldest lot first', () => {
		const ledger = [
			tx('earn', 100, '2026-01-10T00:00:00Z'),
			tx('earn', 50, '2026-02-10T00:00:00Z'),
			tx('redeem', 70, '2026-05-01T00:00:00Z'),
		];
		expect(ledgerExpiry(ledger, six, now, balanceOfLedger(ledger)).expiredPoints).toBe(80);
		expect(ledgerExpiry(ledger, { months: 8 }, now, balanceOfLedger(ledger)).expiredPoints).toBe(30);
	});

	it('handles redeem stored with a positive or negative amount identically', () => {
		const positive = [tx('earn', 100, '2026-01-10T00:00:00Z'), tx('redeem', 60, '2026-02-01T00:00:00Z')];
		const negative = [tx('earn', 100, '2026-01-10T00:00:00Z'), tx('redeem', -60, '2026-02-01T00:00:00Z')];
		expect(ledgerExpiry(positive, six, now, 40).expiredPoints).toBe(40);
		expect(ledgerExpiry(negative, six, now, 40).expiredPoints).toBe(40);
	});

	it('treats a negative adjust as a debit and a positive adjust as a fresh lot', () => {
		const ledger = [
			tx('earn', 100, '2026-01-10T00:00:00Z'),
			tx('adjust', -30, '2026-02-01T00:00:00Z'),
			tx('adjust', 20, '2026-09-01T00:00:00Z'),
		];
		expect(ledgerExpiry(ledger, six, now, balanceOfLedger(ledger)).expiredPoints).toBe(70);
	});

	it('is idempotent once the expire entry is written', () => {
		const ledger = [
			tx('earn', 100, '2026-01-10T00:00:00Z'),
			tx('earn', 50, '2026-02-10T00:00:00Z'),
			tx('redeem', 70, '2026-05-01T00:00:00Z'),
			tx('earn', 40, '2026-08-01T00:00:00Z'),
		];
		const first = ledgerExpiry(ledger, six, now, balanceOfLedger(ledger));
		expect(first.expiredPoints).toBe(80);
		const after = [...ledger, tx('expire', first.expiredPoints, new Date(now).toISOString())];
		expect(balanceOfLedger(after)).toBe(40);
		expect(ledgerExpiry(after, six, now, balanceOfLedger(after)).expiredPoints).toBe(0);
		expect(ledgerExpiry(after, six, at('2026-10-01T12:00:00Z'), balanceOfLedger(after)).expiredPoints).toBe(0);
		expect(ledgerExpiry(after, six, at('2027-02-01T00:00:00Z'), balanceOfLedger(after)).expiredPoints).toBe(40);
	});

	it('stays idempotent when a run was capped by the balance', () => {
		const ledger = [tx('earn', 100, '2026-01-10T00:00:00Z')];
		expect(ledgerExpiry(ledger, six, now, 60).expiredPoints).toBe(60);
		const after = [...ledger, tx('expire', 60, new Date(now).toISOString())];
		expect(ledgerExpiry(after, six, now, 0).expiredPoints).toBe(0);
	});

	it('caps at the current balance', () => {
		const ledger = [tx('earn', 500, '2026-01-10T00:00:00Z')];
		expect(ledgerExpiry(ledger, six, now, 120).expiredPoints).toBe(120);
		expect(ledgerExpiry(ledger, six, now, 0).expiredPoints).toBe(0);
		expect(ledgerExpiry(ledger, six, now, Number.NaN).expiredPoints).toBe(0);
	});

	it('never expires when months is 0 or negative', () => {
		const ledger = [tx('earn', 100, '2020-01-10T00:00:00Z')];
		expect(ledgerExpiry(ledger, { months: 0 }, now, 100).expiredPoints).toBe(0);
		expect(ledgerExpiry(ledger, { months: -3 }, now, 100).expiredPoints).toBe(0);
	});

	it('does not let an orphan debit (no earlier credits) consume later lots’ expiry', () => {
		const ledger = [tx('redeem', 30, '2025-12-01T00:00:00Z'), tx('earn', 100, '2026-01-10T00:00:00Z')];
		expect(ledgerExpiry(ledger, six, now, 70).expiredPoints).toBe(70);
	});

	it('orders unsorted input chronologically (ties keep input order)', () => {
		const ledger = [
			tx('redeem', 70, '2026-05-01T00:00:00Z'),
			tx('earn', 50, '2026-02-10T00:00:00Z'),
			tx('earn', 100, '2026-01-10T00:00:00Z'),
		];
		expect(ledgerExpiry(ledger, { months: 8 }, now, 80).expiredPoints).toBe(30);
		const tie = replayLedger([tx('earn', 1, 'garbage'), tx('earn', 2, 'garbage')]);
		expect(tie.lots.map((lot) => lot.points)).toEqual([1, 2]);
	});
});

describe('lots: credit, debit, debt, restore', () => {
	const t0 = at('2026-01-01T00:00:00Z');

	it('credits open lots; debits consume FIFO and refuse overdrafts unless negative is allowed', () => {
		let state = credit(emptyState(), { id: 'b', points: 50, at: t0 + DAY_MS }).state;
		state = credit(state, { id: 'a', points: 100, at: t0 }).state;
		expect(state.lots.map((lot) => lot.id)).toEqual(['a', 'b']);
		const spent = debit(state, { points: 120 });
		expect(spent.ok && spent.consumed).toEqual([
			{ lotId: 'a', points: 100, earnedAt: '2026-01-01T00:00:00.000Z' },
			{ lotId: 'b', points: 20, earnedAt: '2026-01-02T00:00:00.000Z' },
		]);
		expect(debit(state, { points: 151 })).toEqual({ ok: false, reason: 'insufficient_points', available: 150 });
		const negative = debit(state, { points: 200, allowNegative: true });
		expect(negative.ok && balanceOf(negative.state)).toBe(-50);
		expect(negative.ok && negative.shortfall).toBe(50);
	});

	it('repays debt before opening a lot', () => {
		const owing = { lots: [], debt: 30 };
		const partial = credit(owing, { id: 'x', points: 20, at: t0 });
		expect(partial).toMatchObject({ lot: null, repaid: 20, state: { debt: 10 } });
		const full = credit(partial.state, { id: 'y', points: 25, at: t0 });
		expect(full.repaid).toBe(10);
		expect(full.lot).toMatchObject({ id: 'y', points: 15, remaining: 15 });
		expect(balanceOf(full.state)).toBe(15);
		expect(credit(emptyState(), { id: 'z', points: -5, at: t0 }).lot).toBeNull();
	});

	it('consumes preferred lots first (reversal of an order’s own lot)', () => {
		let state = credit(emptyState(), { id: 'old', points: 100, at: t0 }).state;
		state = credit(state, { id: 'order', points: 40, at: t0 + DAY_MS }).state;
		const result = debit(state, { points: 50, prefer: ['order'] });
		expect(result.ok && result.consumed.map((slice) => [slice.lotId, slice.points])).toEqual([
			['order', 40],
			['old', 10],
		]);
	});

	it('restores released points into their original lots (keeping their expiry) and repays debt first', () => {
		let state = credit(emptyState(), { id: 'a', points: 100, at: t0 }).state;
		const spent = debit(state, { points: 100 });
		if (!spent.ok) throw new Error('debit failed');
		expect(spent.state.lots).toEqual([]);
		const back = restore({ ...spent.state, debt: 10 }, spent.consumed);
		expect(back.repaid).toBe(10);
		expect(back.state.lots).toEqual([{ id: 'a', points: 90, remaining: 90, earnedAt: '2026-01-01T00:00:00.000Z' }]);
		// merge into a partially remaining lot
		state = credit(emptyState(), { id: 'a', points: 100, at: t0 }).state;
		const half = debit(state, { points: 60 });
		if (!half.ok) throw new Error('debit failed');
		const merged = restore(half.state, half.consumed);
		expect(merged.state.lots).toEqual([{ id: 'a', points: 100, remaining: 100, earnedAt: '2026-01-01T00:00:00.000Z' }]);
		expect(restore(emptyState(), [{ lotId: 'q', points: 0, earnedAt: '2026-01-01T00:00:00.000Z' }]).restored).toBe(0);
	});

	it('expires exactly the lots past their expiry, honouring grace days', () => {
		let state = credit(emptyState(), { id: 'jan', points: 100, at: t0 }).state;
		state = credit(state, { id: 'jun', points: 40, at: at('2026-06-01T00:00:00Z') }).state;
		const policy = { months: 6, graceDays: 10 };
		expect(expiryOf(t0, policy)).toBe(at('2026-07-11T00:00:00Z'));
		expect(expiryOf(t0, null)).toBeNull();
		expect(expire(state, at('2026-07-10T23:59:59Z'), policy).expired).toBe(0);
		const run = expire(state, at('2026-07-11T00:00:00Z'), policy);
		expect(run).toMatchObject({ expired: 100, newestEarnedAt: '2026-01-01T00:00:00.000Z' });
		expect(expire(run.state, at('2026-07-11T00:00:00Z'), policy).expired).toBe(0);
		expect(expire(state, at('2030-01-01T00:00:00Z'), null).expired).toBe(0);
		expect(expire(state, at('2030-01-01T00:00:00Z'), policy).newestEarnedAt).toBe('2026-06-01T00:00:00.000Z');
	});
});

describe('upcomingExpiry (ibrahimMobiles upcomingLoyaltyExpiry, in the website zone)', () => {
	const now = at('2026-09-30T12:00:00Z');
	const window = 60 * DAY_MS;
	const lotsOf = (/** @type {any} */ ledger) => replayLedger(ledger);

	it('returns the next lot to expire', () => {
		const state = lotsOf([tx('earn', 100, '2026-04-15T08:00:00Z'), tx('earn', 40, '2026-08-01T00:00:00Z')]);
		expect(upcomingExpiry(state, { now, windowMs: window, timeZone: 'UTC', policy: six })).toMatchObject({
			points: 100,
			expiresAt: '2026-10-15T08:00:00.000Z',
			expiresOn: '2026-10-15',
		});
	});

	it('sums lots expiring on the same local day', () => {
		const state = lotsOf([
			tx('earn', 10, '2026-04-15T08:00:00Z'),
			tx('earn', 15, '2026-04-15T10:00:00Z'),
			tx('earn', 40, '2026-05-20T00:00:00Z'),
		]);
		expect(upcomingExpiry(state, { now, windowMs: window, timeZone: 'UTC', policy: six })).toMatchObject({ points: 25 });
	});

	it('groups by the website’s calendar day, not UTC', () => {
		const state = lotsOf([tx('earn', 10, '2026-04-15T20:00:00Z'), tx('earn', 15, '2026-04-16T02:00:00Z')]);
		const options = { now, windowMs: window, policy: six };
		expect(upcomingExpiry(state, { ...options, timeZone: 'UTC' })).toMatchObject({ points: 10, expiresOn: '2026-10-15' });
		expect(upcomingExpiry(state, { ...options, timeZone: 'Asia/Karachi' })).toMatchObject({
			points: 25,
			expiresOn: '2026-10-16',
		});
		expect(upcomingExpiry(state, { ...options, timeZone: 'America/Los_Angeles' })).toMatchObject({
			points: 25,
			expiresOn: '2026-10-15',
		});
	});

	it('accounts for redemptions, excludes already-expired lots and caps at the balance', () => {
		const ledger = [
			tx('earn', 100, '2026-01-10T00:00:00Z'),
			tx('earn', 50, '2026-04-15T00:00:00Z'),
			tx('redeem', 120, '2026-05-01T00:00:00Z'),
			tx('earn', 40, '2026-06-01T00:00:00Z'),
		];
		const options = { now, windowMs: window, timeZone: 'UTC', policy: six };
		expect(upcomingExpiry(lotsOf(ledger), options)).toMatchObject({ points: 30, expiresAt: '2026-10-15T00:00:00.000Z' });
		// a later redemption consumes the April lot first (FIFO): what is left is the June lot, due 1 Dec
		const spent = lotsOf([...ledger, tx('redeem', 60, '2026-09-01T00:00:00Z')]);
		expect(upcomingExpiry(spent, options)).toBeNull();
		expect(upcomingExpiry(spent, { ...options, windowMs: 90 * DAY_MS })).toMatchObject({ points: 10, expiresOn: '2026-12-01' });
		const stale = lotsOf([tx('earn', 100, '2026-01-10T00:00:00Z'), tx('earn', 20, '2026-05-01T00:00:00Z')]);
		expect(upcomingExpiry(stale, options)).toMatchObject({ points: 20, expiresAt: '2026-11-01T00:00:00.000Z' });
	});

	it('returns null when expiry is off, nothing remains or the window is empty', () => {
		const state = lotsOf([tx('earn', 100, '2026-04-15T00:00:00Z')]);
		expect(upcomingExpiry(state, { now, windowMs: window, timeZone: 'UTC', policy: { months: 0 } })).toBeNull();
		expect(upcomingExpiry(state, { now, windowMs: 0, timeZone: 'UTC', policy: six })).toBeNull();
		expect(upcomingExpiry(state, { now, windowMs: DAY_MS, timeZone: 'UTC', policy: six })).toBeNull();
		expect(
			upcomingExpiry(lotsOf([...[tx('earn', 100, '2026-04-15T00:00:00Z')], tx('redeem', 100, '2026-05-01T00:00:00Z')]), {
				now,
				windowMs: window,
				timeZone: 'UTC',
				policy: six,
			}),
		).toBeNull();
		expect(upcomingExpiry({ lots: state.lots, debt: 100 }, { now, windowMs: window, timeZone: 'UTC', policy: six })).toBeNull();
	});

	it('marks lots as noticed for one expiry day', () => {
		const state = lotsOf([tx('earn', 10, '2026-04-15T08:00:00Z')]);
		const [lot] = state.lots;
		const marked = markNoticed(state, [String(lot?.id)], '2026-10-15');
		expect(marked.lots[0]?.noticeFor).toBe('2026-10-15');
		expect(markNoticed(state, [], 'x').lots[0]?.noticeFor).toBeUndefined();
	});
});
