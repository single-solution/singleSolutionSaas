import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
	canonicalEntry,
	chainEntries,
	draftProblem,
	entryHash,
	genesisHash,
	ledgerActor,
	sumAmounts,
	verifyChain,
} from '../../../src/modules/commerce/core/ledger.js';
import { overlaySwitches, resolverState, statusOf, withHold } from '../../../src/modules/commerce/core/subscription.js';
import { dataScopePrefix, knownUnits, productOf, quotaFeatures } from '../../../src/modules/commerce/core/catalog.js';
import {
	DOCUMENT_TTL_MS,
	documentHash,
	isFresh,
	nextVersion,
	quotaCrossed,
	quotaWatch,
	resourceNeeds,
	validityWindow,
	websiteSection,
} from '../../../src/modules/commerce/core/documents.js';
import {
	checkDayRange,
	checkElementSwitch,
	checkPlanChange,
	checkReason,
	checkReceipt,
	checkSubscribe,
	checkUsageBatch,
	checkUsageRecord,
} from '../../../src/modules/commerce/core/validate.js';
import { APP, M1, M2, W1, couponsManifest } from './fixtures.js';

const T = Date.parse('2026-10-01T10:00:00Z');
const SUB = 'sub_0123456789abcdefghjkmnpq';

describe('ledger chain', () => {
	const drafts = [
		{
			type: /** @type {const} */ ('receipt'),
			amount: 5000,
			entryKey: 'receipt:a',
			reference: 'a',
			actor: { type: 'admin', id: 'adm' },
			details: { amountPaid: 'PKR 5,000', method: 'cash' },
		},
		{
			type: /** @type {const} */ ('day_charge'),
			amount: -1000,
			entryKey: 'day:web_1:app_1:2026-10-01',
			day: '2026-10-01',
			websiteId: 'web_1',
			appId: 'app_1',
			details: { lines: [{ feature: 'codes', hours: 1, amount: 1000 }] },
		},
		{ type: /** @type {const} */ ('day_charge'), amount: -500, entryKey: 'k2', day: '2026-10-02' },
	];
	let n = 0;
	const chain = () =>
		chainEntries({
			merchantId: M1,
			head: { seq: 0, hash: genesisHash(M1) },
			drafts,
			at: new Date(T),
			ids: () => `led_${(n += 1)}`,
		});

	it('chains entries from the genesis hash and verifies them with the account', () => {
		const entries = chain();
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(entries[0]?.prevHash).toBe(genesisHash(M1));
		expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
		expect(genesisHash(M1)).not.toBe(genesisHash(M2));
		const result = verifyChain({
			merchantId: M1,
			entries,
			account: { seq: 3, headHash: String(entries[2]?.hash), balance: 3500 },
		});
		expect(result).toMatchObject({ ok: true, entries: 3, balance: 3500, seq: 3 });
		expect(sumAmounts(entries)).toBe(3500);
		expect(verifyChain({ merchantId: M1, entries: [] })).toMatchObject({ ok: true, seq: 0, headHash: genesisHash(M1) });
	});

	it('detects edits, deletions, reordering, foreign entries and a stale account', () => {
		const entries = chain();
		const edited = entries.map((e, i) => (i === 1 ? { ...e, amount: -1 } : e));
		expect(verifyChain({ merchantId: M1, entries: edited }).problems.map((p) => p.kind)).toEqual(['hash']);
		const deleted = [entries[0], entries[2]].map((e) => /** @type {any} */ (e));
		expect(verifyChain({ merchantId: M1, entries: deleted }).problems.map((p) => p.kind)).toEqual(['gap', 'link']);
		const foreign = entries.map((e, i) => (i === 0 ? { ...e, merchantId: M2 } : e));
		expect(verifyChain({ merchantId: M1, entries: foreign }).problems.map((p) => p.kind)).toEqual(['merchant', 'hash']);
		const swapped = [entries[1], entries[0], entries[2]].map((e) => /** @type {any} */ (e));
		expect(verifyChain({ merchantId: M1, entries: swapped }).ok).toBe(false);
		const stale = verifyChain({ merchantId: M1, entries, account: { seq: 2, headHash: 'x', balance: 1 } });
		expect(stale.problems.filter((p) => p.kind === 'account')).toHaveLength(3);
		const noSeq = verifyChain({ merchantId: M1, entries: [{ ...entries[0], seq: undefined }] });
		expect(noSeq.problems.map((p) => p.kind)).toContain('gap');
	});

	it('canonical form ignores storage metadata and key order but covers every field', () => {
		const [entry] = chain();
		const e = /** @type {any} */ (entry);
		const { hash, ...rest } = e;
		expect(canonicalEntry({ ...rest, createdAt: new Date(), _id: 'other' })).toBe(canonicalEntry(e));
		expect(entryHash(e.prevHash, rest)).toBe(hash);
		expect(entryHash(e.prevHash, { ...rest, reference: 'changed' })).not.toBe(hash);
		expect(entryHash(e.prevHash, { ...rest, at: e.at.toISOString() })).toBe(hash);
		expect(ledgerActor(null)).toBeNull();
		expect(ledgerActor({ type: 'admin', id: 'a', ...{ role: 'owner' } })).toEqual({ type: 'admin', id: 'a' });
	});

	it('validates drafts', () => {
		expect(draftProblem({ type: /** @type {any} */ ('gift'), amount: 1, entryKey: 'k' })).toMatch(/unknown/);
		expect(draftProblem({ type: 'receipt', amount: 1.5, entryKey: 'k' })).toMatch(/integer/);
		expect(draftProblem({ type: 'receipt', amount: 1, entryKey: '' })).toMatch(/entryKey/);
		expect(draftProblem({ type: 'receipt', amount: 0, entryKey: 'k' })).toMatch(/receipts/);
		expect(draftProblem({ type: 'day_charge', amount: 0, entryKey: 'k' })).toMatch(/day charges/);
		expect(draftProblem({ type: 'day_charge', amount: -3, entryKey: 'k' })).toBeNull();
		expect(() =>
			chainEntries({
				merchantId: M1,
				head: { seq: 0, hash: 'h' },
				drafts: [{ type: 'receipt', amount: -1, entryKey: 'k' }],
				at: new Date(),
				ids: () => 'x',
			}),
		).toThrow(/receipts/);
	});

	it('property: any single-field tamper of any entry is detected', () => {
		const entries = chain();
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 }),
				fc.constantFrom('amount', 'type', 'entryKey', 'reference', 'at', 'websiteId'),
				(i, field) => {
					const tampered = entries.map((e, j) => {
						if (j !== i) return e;
						const value =
							field === 'amount'
								? e.amount + 1
								: field === 'at'
									? new Date(T + 1)
									: `${String(/** @type {any} */ (e)[field])}x`;
						return { ...e, [field]: value };
					});
					return !verifyChain({ merchantId: M1, entries: tampered }).ok;
				},
			),
		);
	});
});

describe('subscription state', () => {
	it('derives status and resolver state from holds', () => {
		expect(statusOf({ holds: [] })).toBe('active');
		expect(statusOf({ holds: ['paused'] })).toBe('paused');
		expect(statusOf({ holds: ['paused', 'suspended'] })).toBe('suspended');
		expect(statusOf({ holds: [], cancelledAt: new Date() })).toBe('cancelled');
		expect(statusOf({})).toBe('active');
		expect(resolverState({ holds: ['paused'] })).toEqual({ status: 'paused' });
		expect(resolverState({ holds: ['suspended'] })).toEqual({ status: 'suspended' });
		expect(resolverState({})).toEqual({ status: 'active' });
		expect(withHold(['suspended'], 'paused', true)).toEqual(['paused', 'suspended']);
		expect(withHold(['paused', 'suspended'], 'paused', false)).toEqual(['suspended']);
	});

	it('overlays commerce switches onto config layers (keeping config locks)', () => {
		const layers = { website: { elements: { a: { enabled: false, locked: true }, b: true }, features: { x: { value: 1 } } } };
		expect(overlaySwitches(layers, { website: { a: true }, admin: { c: true } })).toEqual({
			website: { elements: { a: { enabled: true, locked: true }, b: true }, features: { x: { value: 1 } } },
			admin: { elements: { c: { enabled: true } } },
		});
		expect(overlaySwitches(layers, undefined)).toEqual(layers);
		expect(overlaySwitches({}, { website: {}, admin: {} })).toEqual({});
	});
});

describe('catalog helpers', () => {
	const product = productOf(/** @type {any} */ (couponsManifest()));

	it('derives prefixes, units and quotas', () => {
		expect(dataScopePrefix('coupon-box')).toBe('ss_coupon_box_');
		expect([...knownUnits(product)]).toEqual(['redemption']);
		expect(quotaFeatures(product)).toEqual([{ key: 'codes.redemptions', unit: 'redemption', period: 'month', hardStop: true }]);
	});
});

describe('document helpers', () => {
	it('computes validity, freshness and versions', () => {
		expect(validityWindow(T)).toEqual({
			issuedAt: '2026-10-01T10:00:00.000Z',
			validFrom: '2026-10-01T10:00:00.000Z',
			validUntil: new Date(T + DOCUMENT_TTL_MS).toISOString(),
		});
		const cached = { jws: 'a.b.c', validUntil: new Date(T + DOCUMENT_TTL_MS), stale: false };
		expect(isFresh(cached, T)).toBe(true);
		expect(isFresh(cached, T + DOCUMENT_TTL_MS - 60_000)).toBe(false);
		expect(isFresh({ ...cached, stale: true }, T)).toBe(false);
		expect(isFresh({ ...cached, validUntil: null }, T)).toBe(false);
		expect(isFresh(null, T)).toBe(false);
		expect(nextVersion(null, 'h')).toEqual({ version: 1, bumped: true });
		expect(nextVersion({ version: 4, contentHash: 'h' }, 'h')).toEqual({ version: 4, bumped: false });
		expect(nextVersion({ version: 4, contentHash: 'h' }, 'g')).toEqual({ version: 5, bumped: true });
	});

	it('reads hard-stop quotas', () => {
		const resolved = {
			elements: { b: { enabled: true }, a: { enabled: true }, c: { enabled: false } },
			features: { 'a.q': { value: 10, blocked: false }, 'a.s': { value: 3 }, 'a.cfg': { value: 'x' } },
		};
		const watch = quotaWatch(
			[
				{ key: 'a.q', unit: 'u', period: 'month', hardStop: true },
				{ key: 'a.s', unit: 'u', period: 'day', hardStop: false },
				{ key: 'a.cfg', unit: 'u', period: 'day', hardStop: true },
				{ key: 'a.none', unit: 'u', period: 'day', hardStop: true },
			],
			resolved,
		);
		expect(watch).toEqual([{ key: 'a.q', unit: 'u', period: 'month', limit: 10, blocked: false }]);
		expect(quotaCrossed(watch, { 'a.q': 9 })).toBe(false);
		expect(quotaCrossed(watch, { 'a.q': 10 })).toBe(true);
		expect(quotaCrossed(watch, {})).toBe(false);
		expect(
			quotaCrossed(
				[{ ...watch[0], blocked: true }].map((x) => /** @type {any} */ (x)),
				{ 'a.q': 99 },
			),
		).toBe(false);
	});
});

describe('validation', () => {
	it('subscribe, plan, element and reason inputs', () => {
		expect(checkSubscribe({ appId: APP })).toEqual({ ok: true, value: { appId: APP, planCode: null } });
		expect(checkSubscribe({ appId: APP, planCode: 'pro' })).toEqual({ ok: true, value: { appId: APP, planCode: 'pro' } });
		expect(checkSubscribe({ appId: 'x', planCode: 'Bad!', extra: 1 })).toMatchObject({ ok: false });
		expect(checkSubscribe(null)).toMatchObject({ ok: false });
		expect(checkPlanChange({ planCode: null })).toEqual({ ok: true, value: { planCode: null } });
		expect(checkPlanChange({ planCode: 'pro' })).toEqual({ ok: true, value: { planCode: 'pro' } });
		expect(checkPlanChange({})).toMatchObject({ ok: false });
		expect(checkPlanChange({ planCode: 5 })).toMatchObject({ ok: false });
		expect(checkPlanChange([])).toMatchObject({ ok: false });
		expect(checkElementSwitch('codes', { enabled: true })).toEqual({ ok: true, value: { elementKey: 'codes', enabled: true } });
		expect(checkElementSwitch('Bad', { enabled: 'yes', x: 1 })).toMatchObject({ ok: false });
		expect(checkElementSwitch('codes', 'x')).toMatchObject({ ok: false });
		expect(checkReason(undefined, 'dflt')).toEqual({ ok: true, value: { reason: 'dflt' } });
		expect(checkReason({}, 'dflt')).toEqual({ ok: true, value: { reason: 'dflt' } });
		expect(checkReason({ reason: 'too_expensive' }, 'dflt')).toEqual({ ok: true, value: { reason: 'too_expensive' } });
		expect(checkReason({ reason: 'Not A Code' }, 'dflt')).toMatchObject({ ok: false });
		expect(checkReason('x', 'dflt')).toMatchObject({ ok: false });
	});

	it('receipts (PLAN 0.5.8) and day ranges', () => {
		expect(checkReceipt({ credits: 5, amountPaid: ' PKR 5,000 ', method: 'Bank', reference: 'TX-1' })).toEqual({
			ok: true,
			value: { amount: 5000, amountPaid: 'PKR 5,000', method: 'Bank', reference: 'TX-1' },
		});
		expect(checkReceipt({ credits: 1, amountPaid: 'x', method: 'y', reference: '' })).toMatchObject({
			value: { reference: null },
		});
		expect(checkReceipt({ credits: 0, amountPaid: 'x', method: 'y' })).toMatchObject({ ok: false });
		expect(
			checkReceipt({ credits: 1.5, amountPaid: '', method: 'y'.repeat(61), reference: 'r'.repeat(121), x: 1 }),
		).toMatchObject({
			ok: false,
			errors: expect.arrayContaining([{ path: '/credits', message: expect.any(String) }]),
		});
		expect(checkReceipt('x')).toMatchObject({ ok: false });
		const now = Date.parse('2026-10-15T12:00:00Z');
		expect(checkDayRange({}, now)).toEqual({
			ok: true,
			value: { from: '2026-09-16', to: '2026-10-15', websiteId: null, merchantId: null, method: null },
		});
		expect(
			checkDayRange({ from: '2026-09-01', to: '2026-09-02', websiteId: W1, merchantId: M1, method: 'Bank' }, now),
		).toMatchObject({
			ok: true,
			value: { websiteId: W1, merchantId: M1, method: 'Bank' },
		});
		for (const query of [
			{ from: 'yesterday' },
			{ from: '2026-09-02', to: '2026-09-01' },
			{ from: '2024-01-01', to: '2026-01-01' },
			{ websiteId: 'bad' },
			{ merchantId: 'bad' },
			{ method: 'm'.repeat(61) },
		])
			expect(checkDayRange(query, now)).toMatchObject({ ok: false });
	});

	it('usage batches and records', () => {
		expect(checkUsageBatch({ records: [{}] })).toMatchObject({ ok: true });
		expect(checkUsageBatch({ records: [] })).toMatchObject({ ok: false });
		expect(checkUsageBatch({ records: [{}], x: 1 })).toMatchObject({ ok: false });
		expect(checkUsageBatch([])).toMatchObject({ ok: false });
		const good = {
			websiteId: W1,
			subscriptionId: SUB,
			unit: 'redemption',
			quantity: 3,
			idempotencyKey: 'k-1',
			occurredAt: '2026-10-01T10:00:00Z',
		};
		expect(checkUsageRecord(good)).toMatchObject({
			ok: true,
			value: { quantity: 3, occurredAt: new Date('2026-10-01T10:00:00Z') },
		});
		expect(checkUsageRecord(null)).toEqual({ ok: false, reason: 'invalid_record', idempotencyKey: null });
		expect(checkUsageRecord({ ...good, idempotencyKey: 'has space' })).toMatchObject({ reason: 'invalid_idempotency_key' });
		expect(checkUsageRecord({ ...good, extra: 1 })).toMatchObject({ reason: 'invalid_record', idempotencyKey: 'k-1' });
		expect(checkUsageRecord({ ...good, websiteId: 'x' })).toMatchObject({ reason: 'invalid_record' });
		expect(checkUsageRecord({ ...good, unit: 'Bad Unit' })).toMatchObject({ reason: 'unknown_unit' });
		expect(checkUsageRecord({ ...good, quantity: -1 })).toMatchObject({ reason: 'invalid_quantity' });
		expect(checkUsageRecord({ ...good, quantity: 1.5 })).toMatchObject({ reason: 'invalid_quantity' });
		expect(checkUsageRecord({ ...good, occurredAt: 'today' })).toMatchObject({ reason: 'invalid_occurred_at' });
	});
});

describe('documents: website section, hash and resource needs (F.16)', () => {
	it('builds the website section from set settings and extends the content hash', () => {
		expect(websiteSection({ timeZone: null, language: undefined })).toBeNull();
		expect(websiteSection({ timeZone: 'UTC', currency: 'EUR', language: null })).toEqual({ timeZone: 'UTC', currency: 'EUR' });
		expect(documentHash('h', null, null)).toBe('h');
		const identityOnly = documentHash('h', { issuer: 'x' });
		expect(documentHash('h', { issuer: 'x' }, null)).toBe(identityOnly);
		expect(documentHash('h', null, { timeZone: 'UTC' })).not.toBe('h');
		expect(documentHash('h', { issuer: 'x' }, { timeZone: 'UTC' })).not.toBe(identityOnly);
	});

	it('product-level kinds are always needed, element-level kinds only while the element is on', () => {
		const manifest = {
			requires: { resources: ['database'] },
			elements: [
				{ key: 'a', requires: { resources: ['ai', 'database'] } },
				{ key: 'b', requires: { resources: ['storage'] } },
				{ key: 'c', requires: { resources: ['storage'] } },
				{ key: 'd' },
			],
		};
		expect(
			resourceNeeds(manifest, {
				a: { enabled: false, reason: 'not_in_plan' },
				b: { enabled: false, reason: 'resource_missing' },
			}),
		).toEqual([
			{ kind: 'ai', scope: 'element', elements: ['a'], neededNow: false },
			{ kind: 'database', scope: 'product', elements: ['a'], neededNow: true },
			{ kind: 'storage', scope: 'element', elements: ['b', 'c'], neededNow: true },
		]);
	});
});
