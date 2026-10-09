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
import { checkAddProduct, checkDayRange, checkReceipt } from '../../../src/modules/commerce/core/validate.js';
import { M1, M2, W1 } from './fixtures.js';

const T = Date.parse('2026-10-01T10:00:00Z');

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

describe('validation', () => {
	it('add product input', () => {
		expect(checkAddProduct({ productId: 'ecommerce' })).toEqual({ ok: true, value: { productId: 'ecommerce' } });
		expect(checkAddProduct({ productId: 'Bad Id', x: 1 })).toMatchObject({
			ok: false,
			errors: [
				{ path: '/x', message: 'unknown property' },
				{ path: '/productId', message: 'must be a product id' },
			],
		});
		expect(checkAddProduct(null)).toMatchObject({ ok: false });
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
});
