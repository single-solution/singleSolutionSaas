import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normaliseProduct, planSettlement } from '@ss/entitlements';
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
import {
	overlaySwitches,
	pauseReasonOf,
	pinAt,
	resolverState,
	runsNextHour,
	sameElements,
	statusOf,
	timelineEvents,
	withHold,
} from '../../../src/modules/commerce/core/subscription.js';
import {
	dataScopePrefix,
	firstHourCharge,
	knownUnits,
	productOf,
	quotaFeatures,
	settlementCatalog,
	unitPeriod,
} from '../../../src/modules/commerce/core/catalog.js';
import {
	DOCUMENT_TTL_MS,
	documentHash,
	enabledElements,
	isFresh,
	nextVersion,
	quotaCrossed,
	quotaWatch,
	resourceNeeds,
	validityWindow,
	websiteSection,
} from '../../../src/modules/commerce/core/documents.js';
import {
	checkCreditOperation,
	checkElementSwitch,
	checkPlanChange,
	checkReason,
	checkSpendCap,
	checkStatementQuery,
	checkSubscribe,
	checkUsageBatch,
	checkUsageRecord,
} from '../../../src/modules/commerce/core/validate.js';
import { bookOrThrow, meteredDraft, settlementDraft, subscriptionBurn } from '../../../src/modules/commerce/core/billing.js';
import { APP, M1, M2, W1, couponsManifest, freeManifest } from './fixtures.js';

const T = Date.parse('2026-10-01T10:00:00Z');
const H = 3_600_000;
const SUB = 'sub_0123456789abcdefghjkmnpq';

describe('ledger chain', () => {
	const drafts = [
		{
			type: /** @type {const} */ ('deposit'),
			amount: 5000,
			entryKey: 'deposit:a',
			reference: 'a',
			note: 'n',
			actor: { type: 'staff', id: 'stf' },
		},
		{
			type: /** @type {const} */ ('settlement'),
			amount: -1500,
			entryKey: 'k1',
			periodKey: 'k1',
			periodStart: new Date(T),
			details: { x: 1 },
		},
		{ type: /** @type {const} */ ('settlement'), amount: 0, entryKey: 'k2', periodKey: 'k2' },
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
		expect(entryHash(e.prevHash, { ...rest, note: 'changed' })).not.toBe(hash);
		expect(entryHash(e.prevHash, { ...rest, at: e.at.toISOString() })).toBe(hash);
		expect(ledgerActor(null)).toBeNull();
		expect(ledgerActor({ type: 'staff', id: 'a', ...{ roles: ['x'] } })).toEqual({ type: 'staff', id: 'a' });
	});

	it('validates drafts', () => {
		expect(draftProblem({ type: /** @type {any} */ ('gift'), amount: 1, entryKey: 'k' })).toMatch(/unknown/);
		expect(draftProblem({ type: 'deposit', amount: 1.5, entryKey: 'k' })).toMatch(/integer/);
		expect(draftProblem({ type: 'deposit', amount: 1, entryKey: '' })).toMatch(/entryKey/);
		expect(draftProblem({ type: 'settlement', amount: 1, entryKey: 'k' })).toMatch(/charges/);
		expect(draftProblem({ type: 'metered', amount: 1, entryKey: 'k' })).toMatch(/charges/);
		expect(draftProblem({ type: 'deposit', amount: 0, entryKey: 'k' })).toMatch(/deposits/);
		expect(draftProblem({ type: 'refund', amount: 5, entryKey: 'k' })).toMatch(/refunds/);
		expect(draftProblem({ type: 'adjustment', amount: 0, entryKey: 'k' })).toMatch(/adjustments/);
		expect(draftProblem({ type: 'adjustment', amount: -3, entryKey: 'k' })).toBeNull();
		expect(() =>
			chainEntries({
				merchantId: M1,
				head: { seq: 0, hash: 'h' },
				drafts: [{ type: 'deposit', amount: -1, entryKey: 'k' }],
				at: new Date(),
				ids: () => 'x',
			}),
		).toThrow(/deposits/);
	});

	it('property: any single-field tamper of any entry is detected', () => {
		const entries = chain();
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 }),
				fc.constantFrom('amount', 'type', 'entryKey', 'note', 'at', 'websiteId'),
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
		expect(statusOf({ holds: ['spend_cap'] })).toBe('paused');
		expect(statusOf({ holds: ['paused', 'suspended'] })).toBe('suspended');
		expect(statusOf({ holds: [], cancelledAt: new Date() })).toBe('cancelled');
		expect(statusOf({})).toBe('active');
		expect(resolverState({ holds: ['spend_cap'] })).toEqual({ status: 'active', spendCap: true });
		expect(resolverState({ holds: ['insufficient_credits', 'spend_cap'] })).toEqual({ status: 'paused', spendCap: false });
		expect(resolverState({ holds: ['suspended'] })).toEqual({ status: 'suspended', spendCap: false });
		expect(resolverState({ holds: [], cancelledAt: new Date() })).toEqual({ status: 'cancelled', spendCap: false });
		expect(resolverState({})).toEqual({ status: 'active', spendCap: false });
		expect(pauseReasonOf('insufficient_credits')).toBe('balance');
		expect(pauseReasonOf('paused')).toBe('paused');
		expect(withHold(['spend_cap'], 'paused', true)).toEqual(['paused', 'spend_cap']);
		expect(withHold(['paused', 'spend_cap'], 'paused', false)).toEqual(['spend_cap']);
		expect(runsNextHour({ holds: [] })).toBe(true);
		expect(runsNextHour({ holds: ['spend_cap'] })).toBe(false);
		expect(runsNextHour({ holds: ['spend_cap'] }, { ignoreSpendCap: true })).toBe(true);
		expect(runsNextHour({ holds: ['paused', 'spend_cap'] }, { ignoreSpendCap: true })).toBe(false);
		expect(runsNextHour({ holds: [], cancelledAt: new Date() })).toBe(false);
	});

	it('finds the pin in effect', () => {
		const pins = [
			{ version: 'b', manifestVersion: 2, planCode: 'pro', at: new Date(T + 2 * H) },
			{ version: 'a', manifestVersion: 1, planCode: null, at: new Date(T) },
		];
		expect(pinAt(pins, T - H).version).toBe('a');
		expect(pinAt(pins, T + H).version).toBe('a');
		expect(pinAt(pins, T + 2 * H).version).toBe('b');
		expect(() => pinAt([], T)).toThrow(/pin/);
	});

	it('turns snapshots into timeline events', () => {
		expect(
			timelineEvents([
				{ at: T, elements: ['a', 'b'] },
				{ at: T + H, elements: ['b', 'c'] },
				{ at: T + 2 * H, elements: ['b', 'c'] },
			]),
		).toEqual([
			{ at: '2026-10-01T10:00:00.000Z', element: 'a', enabled: true },
			{ at: '2026-10-01T10:00:00.000Z', element: 'b', enabled: true },
			{ at: '2026-10-01T11:00:00.000Z', element: 'c', enabled: true },
			{ at: '2026-10-01T11:00:00.000Z', element: 'a', enabled: false },
		]);
		expect(sameElements(['b', 'a'], ['a', 'b'])).toBe(true);
		expect(sameElements(['a'], ['a', 'b'])).toBe(false);
		expect(sameElements(null, [])).toBe(false);
		expect(sameElements(['a'], ['b'])).toBe(false);
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

	it('derives prefixes, units, quotas and the first hour', () => {
		expect(dataScopePrefix('coupon-box')).toBe('ss_coupon_box_');
		expect([...knownUnits(product)]).toEqual(['redemption']);
		expect(quotaFeatures(product)).toEqual([{ key: 'codes.redemptions', unit: 'redemption', period: 'month', hardStop: true }]);
		expect(unitPeriod(product, 'redemption')).toBe('month');
		expect(unitPeriod(product, 'other')).toBe('month');
		expect(firstHourCharge(product, 'starter', T)?.amount).toBe(1500);
		expect(firstHourCharge(product, 'pro', T)?.amount).toBe(3750);
		expect(firstHourCharge(product, null, T)?.amount).toBe(0); // no plan: product defaults (off)
		expect(firstHourCharge(product, 'starter', Date.parse('2025-01-01T00:00:00Z'))).toBeNull();
	});

	it('builds a settlement catalog over every pinned manifest version', () => {
		const v1 = couponsManifest();
		const v2 = couponsManifest({
			version: '2.0.0',
			priceBook: '2026-10',
			effectiveFrom: '2026-10-01T00:00:00Z',
			codesHourly: 2000,
		});
		const extra = { ...v2, elements: [...v2.elements, { key: 'extra', name: 'X', modes: ['C'], price: { hourly: 7 } }] };
		const catalog = settlementCatalog(/** @type {any} */ ([v1, extra]));
		expect(catalog.priceBooks.map((b) => [b.version, b.elements.codes, b.elements.extra])).toEqual([
			['2026-01', 1000, 0],
			['2026-10', 2000, 7],
		]);
		expect(catalog.priceBooks[0]?.metered.redemption?.included).toEqual({ starter: 5, pro: 100 });
		expect(settlementCatalog(/** @type {any} */ ([freeManifest()])).priceBooks).toHaveLength(1);
		expect(() => settlementCatalog([])).toThrow(/no manifests/);
		expect(bookOrThrow(catalog, '2026-10').version).toBe('2026-10');
		expect(() => bookOrThrow(catalog, 'nope')).toThrow(/unknown price book/);
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

	it('reads billable elements and hard-stop quotas', () => {
		const resolved = {
			elements: { b: { enabled: true }, a: { enabled: true }, c: { enabled: false } },
			features: { 'a.q': { value: 10, blocked: false }, 'a.s': { value: 3 }, 'a.cfg': { value: 'x' } },
		};
		expect(enabledElements(resolved)).toEqual(['a', 'b']);
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

	it('credit operations and the spend cap', () => {
		expect(checkCreditOperation('credit', { amountMillicredits: 5, reference: 'r1', note: ' n ' })).toEqual({
			ok: true,
			value: { amountMillicredits: 5, reference: 'r1', note: 'n' },
		});
		expect(checkCreditOperation('credit', { amountMillicredits: -5, reference: 'r1', note: 'n' })).toMatchObject({ ok: false });
		expect(checkCreditOperation('refund', { amountMillicredits: 0, reference: 'r1', note: 'n' })).toMatchObject({ ok: false });
		expect(checkCreditOperation('adjustment', { amountMillicredits: -5, reference: 'r1', note: 'n' })).toMatchObject({
			ok: true,
		});
		expect(checkCreditOperation('adjustment', { amountMillicredits: 0, reference: 'r1', note: 'n' })).toMatchObject({
			ok: false,
		});
		expect(checkCreditOperation('credit', { amountMillicredits: 1.5, reference: 'has space', note: '', x: 1 })).toMatchObject({
			ok: false,
		});
		expect(checkCreditOperation('credit', 'x')).toMatchObject({ ok: false });
		expect(checkSpendCap({ limit: 10 })).toEqual({ ok: true, value: { limit: 10 } });
		expect(checkSpendCap({ limit: 0 })).toMatchObject({ ok: false });
		expect(checkSpendCap({ limit: 1, other: 1 })).toMatchObject({ ok: false });
		expect(checkSpendCap(5)).toMatchObject({ ok: false });
	});

	it('statement queries', () => {
		const now = Date.parse('2026-10-15T12:00:00Z');
		expect(checkStatementQuery({}, now)).toEqual({
			ok: true,
			value: { from: Date.parse('2026-10-01T00:00:00Z'), to: now + 1, websiteId: null },
		});
		expect(checkStatementQuery({ from: '2026-09-01', to: '2026-09-02T00:00:00Z', websiteId: W1 }, now)).toMatchObject({
			ok: true,
			value: { websiteId: W1 },
		});
		expect(checkStatementQuery({ from: 'yesterday' }, now)).toMatchObject({ ok: false });
		expect(checkStatementQuery({ from: '2026-09-02', to: '2026-09-01' }, now)).toMatchObject({ ok: false });
		expect(checkStatementQuery({ from: '2024-01-01', to: '2026-01-01' }, now)).toMatchObject({ ok: false });
		expect(checkStatementQuery({ websiteId: 'bad' }, now)).toMatchObject({ ok: false });
		expect(checkStatementQuery({ from: '' }, now)).toMatchObject({ ok: true });
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

describe('billing composition', () => {
	const catalog = settlementCatalog(/** @type {any} */ ([couponsManifest()]));
	const sub = { _id: SUB, websiteId: W1, appId: APP };
	const plan = planSettlement({
		subscription: { id: SUB, startedAt: '2026-10-01T10:00:00Z', priceBookVersion: '2026-01' },
		priceBook: catalog,
		elementTimeline: [{ at: '2026-10-01T10:00:00Z', element: 'codes', enabled: true }],
		from: '2026-10-01T10:00:00Z',
		to: '2026-10-01T12:00:00Z',
	});

	it('settlement and metered drafts', () => {
		const [bucket] = plan.buckets;
		const draft = settlementDraft(sub, /** @type {any} */ (bucket));
		expect(draft).toMatchObject({ type: 'settlement', amount: -1000, entryKey: `${SUB}:2026-10-01T10:00:00Z`, websiteId: W1 });
		expect(settlementDraft(sub, /** @type {any} */ ({ ...bucket, amount: 0 })).amount).toBe(0);
		const book = bookOrThrow(catalog, '2026-01');
		const metered = meteredDraft({
			sub,
			bucket: /** @type {any} */ (bucket),
			book,
			planCode: 'starter',
			quantities: { redemption: 8 },
			before: { redemption: 0 },
		});
		expect(metered).toMatchObject({ type: 'metered', amount: -30, entryKey: `${SUB}:2026-10-01T10:00:00Z:metered` });
		const later = meteredDraft({
			sub,
			bucket: /** @type {any} */ (bucket),
			book,
			planCode: 'starter',
			quantities: { redemption: 2 },
			before: { redemption: 1 },
		});
		expect(later?.amount).toBe(0); // 1 + 2 ≤ 5 included
		expect(
			meteredDraft({
				sub,
				bucket: /** @type {any} */ (bucket),
				book,
				planCode: null,
				quantities: { redemption: 1 },
				before: {},
			})?.amount,
		).toBe(-10);
		expect(
			meteredDraft({
				sub,
				bucket: /** @type {any} */ (bucket),
				book,
				planCode: 'starter',
				quantities: { other: 4, redemption: 0 },
				before: {},
			}),
		).toBeNull();
	});

	it('burn rates', () => {
		const pins = [{ version: '2026-01', at: T }];
		expect(subscriptionBurn({ product: catalog, pins, startedAt: T, elements: ['codes', 'apply_box', 'gone'], at: T })).toBe(
			1500,
		);
		expect(
			subscriptionBurn({
				product: catalog,
				pins: [{ version: '2026-01', at: T + H }],
				startedAt: T,
				elements: ['codes'],
				at: T,
			}),
		).toBe(0);
	});

	it('exports the product normaliser', () => {
		expect(normaliseProduct).toBeTypeOf('function');
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
