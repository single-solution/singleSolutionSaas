/**
 * The shopper extras' pure rules: claim windows and checks, review checks and summaries, alerts, compare, reports'
 * ranges and rows, keyset pages.
 */
import { describe, expect, it } from 'vitest';
import { checkAlertInput, dueConditions, isDue, priceOf } from '../core/alerts.js';
import { compareRows, gradeLabels, parseCompareIds } from '../core/compare.js';
import { afterFilter, keyOf, sortOf } from '../core/extras-pages.js';
import { parseRange, returnRateRows, stockAgeRows } from '../core/reports.js';
import {
	DAY_MS,
	actionsOf,
	checkClaimInput,
	checkNote,
	checkPhotoInput,
	claimValue,
	holdsUnits,
	isPhotoKey,
	paidOnline,
	photoFolder,
	planClaim,
	pointsToReverse,
	refundCap,
	refundedState,
	returnableLines,
	windowDays,
	windowOf,
} from '../core/returns.js';
import { checkReply, checkReviewInput, ratingSummary, reviewSort } from '../core/reviews.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');

/** @param {Partial<import('../core/model.js').OrderLineRecord>} line */
const lineOf = (line) =>
	/** @type {import('../core/model.js').OrderLineRecord} */ ({
		id: 'oln_1',
		productId: 'prd_1',
		variantId: 'var_1',
		kind: 'physical',
		name: 'Phone',
		variantName: '',
		sku: '',
		grade: null,
		gradeLabel: '',
		image: null,
		unitPrice: 1000,
		quantity: 2,
		discount: 0,
		tax: 0,
		total: 2000,
		cost: null,
		categoryIds: [],
		brandId: null,
		locationId: null,
		serials: [],
		booking: null,
		licences: [],
		returnedQuantity: 0,
		...line,
	});

describe('claim windows', () => {
	const defaults = { returnDays: 7, warrantyDays: 0 };
	it('take the product, then the grade, then the setting', () => {
		expect(windowDays('return', { returnDays: 3, warrantyDays: null }, { key: 'a', returnDays: 30 }, defaults)).toBe(3);
		expect(windowDays('return', { returnDays: null, warrantyDays: null }, { key: 'a', returnDays: 30 }, defaults)).toBe(30);
		expect(windowDays('warranty', null, { key: 'a' }, defaults)).toBe(0);
		expect(windowDays('return', null, null, { returnDays: -1, warrantyDays: 0 })).toBe(0);
		expect(windowOf(0, new Date(NOW), NOW)).toEqual({ days: 0, until: null, open: false });
		expect(windowOf(5, null, NOW).open).toBe(false);
		expect(windowOf(1, new Date(NOW - 2 * DAY_MS), NOW).open).toBe(false);
	});

	it('count units held by claims and plan a claim', () => {
		const order = {
			lines: [
				lineOf({ serials: ['S1', 'S2'], grade: 'a' }),
				lineOf({ id: 'oln_2', kind: 'digital' }),
				lineOf({ id: 'oln_3', productId: 'prd_gone', quantity: 1 }),
			],
			deliveredAt: new Date(NOW - DAY_MS),
		};
		const claims = /** @type {any[]} */ ([
			{ status: 'requested', kind: 'return', refundAmount: 0, lines: [{ lineId: 'oln_1', quantity: 1, serials: ['S1'] }] },
			{ status: 'rejected', kind: 'return', refundAmount: 0, lines: [{ lineId: 'oln_1', quantity: 1, serials: ['S2'] }] },
			{ status: 'closed', kind: 'warranty', refundAmount: 0, lines: [{ lineId: 'oln_1', quantity: 1, serials: ['S2'] }] },
		]);
		const lines = returnableLines({
			order,
			claims,
			products: new Map([['prd_1', { returnDays: null, warrantyDays: null }]]),
			grades: [{ key: 'a', warrantyDays: 90 }],
			defaults: { returnDays: 7, warrantyDays: 0 },
			now: NOW,
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ claimable: 1, freeSerials: ['S2'] });
		expect(lines[0]?.warranty.open).toBe(true);
		expect(lines[1]?.warranty.open).toBe(false);
		expect(planClaim('return', [{ lineId: 'oln_9', quantity: 1 }], lines)).toMatchObject({ ok: false, reason: 'unknown' });
		expect(planClaim('warranty', [{ lineId: 'oln_3', quantity: 1 }], lines)).toMatchObject({ reason: 'window_closed' });
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 2 }], lines)).toMatchObject({ reason: 'quantity' });
		expect(planClaim('return', [{ lineId: 'oln_1', quantity: 1 }], lines)).toEqual({
			ok: true,
			lines: [{ lineId: 'oln_1', quantity: 1, serials: ['S2'] }],
		});
		expect(holdsUnits({ status: 'closed', kind: 'warranty', refundAmount: 5 })).toBe(true);
	});

	it('check claims, photos and notes', () => {
		const ok = { orderId: 'ord_1', kind: 'return', lines: [{ lineId: 'oln_1', quantity: 1 }], reason: ' Broken \u0007' };
		expect(checkClaimInput(ok, { maxPhotos: 2 })).toMatchObject({ ok: true, value: { reason: 'Broken', photos: [] } });
		expect(checkClaimInput(null, { maxPhotos: 2 })).toMatchObject({ field: 'orderId' });
		expect(checkClaimInput({ ...ok, kind: 'x' }, { maxPhotos: 2 })).toMatchObject({ field: 'kind' });
		expect(checkClaimInput({ ...ok, lines: [] }, { maxPhotos: 2 })).toMatchObject({ field: 'lines' });
		expect(checkClaimInput({ ...ok, lines: [null] }, { maxPhotos: 2 })).toMatchObject({ field: 'lines/0/lineId' });
		expect(
			checkClaimInput(
				{
					...ok,
					lines: [
						{ lineId: 'a', quantity: 1 },
						{ lineId: 'a', quantity: 1 },
					],
				},
				{ maxPhotos: 2 },
			),
		).toMatchObject({ field: 'lines/1/lineId' });
		expect(checkClaimInput({ ...ok, lines: [{ lineId: 'a', quantity: 0 }] }, { maxPhotos: 2 })).toMatchObject({
			field: 'lines/0/quantity',
		});
		expect(checkClaimInput({ ...ok, reason: '' }, { maxPhotos: 2 })).toMatchObject({ field: 'reason' });
		expect(checkClaimInput({ ...ok, reason: 5 }, { maxPhotos: 2 })).toMatchObject({ field: 'reason' });
		expect(checkClaimInput({ ...ok, photos: ['a', 'b', 'c'] }, { maxPhotos: 2 })).toMatchObject({ field: 'photos' });
		expect(checkClaimInput({ ...ok, photos: ['a', 'a'] }, { maxPhotos: 2 })).toMatchObject({ field: 'photos' });
		expect(checkPhotoInput({ type: 'image/gif', size: 1 }, { photoMaxMb: 1 })).toMatchObject({ field: 'type' });
		expect(checkPhotoInput(null, { photoMaxMb: 1 })).toMatchObject({ field: 'type' });
		expect(checkPhotoInput({ type: 'image/png', size: 2_000_000 }, { photoMaxMb: 1 })).toMatchObject({ field: 'size' });
		expect(checkPhotoInput({ type: 'image/webp', size: 10 }, { photoMaxMb: 1 })).toMatchObject({ ok: true, extension: 'webp' });
		expect(photoFolder('usr/1 x')).toBe('ecommerce/returns/usr_1_x/');
		expect(isPhotoKey('ecommerce/returns/usr_1/pho_1.jpg', 'usr_1')).toBe(true);
		expect(isPhotoKey('ecommerce/returns/usr_2/pho_1.jpg', 'usr_1')).toBe(false);
		expect(isPhotoKey('ecommerce/returns/usr_1/../x.jpg', 'usr_1')).toBe(false);
		expect(checkNote('x'.repeat(1001))).toMatchObject({ ok: false });
		expect(checkNote('', true)).toMatchObject({ ok: false });
		expect(checkNote(undefined)).toEqual({ ok: true, note: '' });
	});

	it('cap refunds and take back points in proportion', () => {
		const order = /** @type {any} */ ({
			lines: [lineOf({ total: 1999, quantity: 2 }), lineOf({ id: 'oln_2', total: 1000, quantity: 1 })],
			totals: { total: 2999 },
			payment: { paymentId: 'pay_1', state: 'paid', paid: 2999, refunded: 0 },
			promotions: { pointsEarned: 30 },
		});
		const claim = {
			lines: [
				{ lineId: 'oln_1', quantity: 1, serials: [] },
				{ lineId: 'oln_x', quantity: 1, serials: [] },
			],
			refundAmount: 0,
		};
		expect(claimValue(order, claim)).toBe(999);
		expect(refundCap(order, claim)).toBe(999);
		expect(refundCap({ ...order, payment: { ...order.payment, refunded: 2500 } }, claim)).toBe(499);
		expect(refundCap(order, { ...claim, refundAmount: 2000 })).toBe(0);
		expect(pointsToReverse(order, claim)).toBe(9);
		expect(pointsToReverse({ ...order, promotions: { pointsEarned: 0 } }, claim)).toBe(0);
		expect(paidOnline(order)).toBe(true);
		expect(paidOnline({ payment: { ...order.payment, state: 'unpaid' } })).toBe(false);
		expect(refundedState(order, 2999)).toBe('refunded');
		expect(refundedState({ ...order, payment: { ...order.payment, paid: 0 } }, 100)).toBe('partially_refunded');
		expect(actionsOf({ status: 'refunded', restockedAt: new Date() })).toEqual(['refund', 'close']);
		expect(actionsOf({ status: 'requested', restockedAt: null })).toEqual(['approve', 'reject']);
	});
});

describe('reviews', () => {
	it('check input, replies, sorts and summaries', () => {
		expect(checkReviewInput({ productId: 'prd_1', rating: 5, title: ' Great ', body: 'Fine' })).toEqual({
			ok: true,
			value: { productId: 'prd_1', rating: 5, title: 'Great', body: 'Fine' },
		});
		expect(checkReviewInput(null)).toMatchObject({ field: 'productId' });
		expect(checkReviewInput({ productId: 'prd_1', rating: 6 })).toMatchObject({ field: 'rating' });
		expect(checkReviewInput({ productId: 'prd_1', rating: 1, title: 'x'.repeat(121) })).toMatchObject({ field: 'title' });
		expect(checkReviewInput({ productId: 'prd_1', rating: 1, body: 'x'.repeat(2001) })).toMatchObject({ field: 'body' });
		expect(checkReply('x'.repeat(2001))).toMatchObject({ ok: false });
		expect(checkReply(' Thanks ')).toEqual({ ok: true, reply: 'Thanks' });
		expect(reviewSort('lowest')).toBe('lowest');
		expect(reviewSort('nope')).toBe('newest');
		expect(
			ratingSummary([
				{ rating: 5, count: 2 },
				{ rating: 2, count: 1 },
				{ rating: 9, count: 4 },
			]),
		).toEqual({ average: 4, count: 3, stars: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 2 } });
		expect(ratingSummary([]).average).toBe(0);
	});
});

describe('alerts and compare', () => {
	const product = /** @type {any} */ ({
		status: 'active',
		inStock: false,
		trackStock: true,
		price: 900,
		variants: [
			{ id: 'var_a', active: true, stock: 0, price: 900 },
			{ id: 'var_b', active: true, stock: 2, price: 1200 },
			{ id: 'var_c', active: false, stock: 2, price: 100 },
		],
		specs: { att_1: '6 GB', att_2: true },
	});
	it('check alerts and tell when they are due', () => {
		expect(checkAlertInput({ kind: 'price_drop', productId: 'prd_1' })).toEqual({
			ok: true,
			value: { kind: 'price_drop', productId: 'prd_1', variantId: null },
		});
		expect(checkAlertInput(null)).toMatchObject({ field: 'kind' });
		expect(checkAlertInput({ kind: 'back_in_stock', productId: 'x' })).toMatchObject({ field: 'productId' });
		expect(checkAlertInput({ kind: 'back_in_stock', productId: 'prd_1', variantId: 'v' })).toMatchObject({
			field: 'variantId',
		});
		expect(priceOf(product, 'var_c')).toBeNull();
		expect(priceOf(product, 'var_b')).toBe(1200);
		expect(isDue({ kind: 'back_in_stock', variantId: null, price: null }, product)).toBe(false);
		expect(isDue({ kind: 'back_in_stock', variantId: 'var_b', price: null }, product)).toBe(true);
		expect(isDue({ kind: 'back_in_stock', variantId: 'var_x', price: null }, product)).toBe(false);
		expect(isDue({ kind: 'price_drop', variantId: null, price: 1000 }, product)).toBe(true);
		expect(isDue({ kind: 'price_drop', variantId: 'var_c', price: 1000 }, product)).toBe(false);
		expect(isDue({ kind: 'price_drop', variantId: null, price: null }, product)).toBe(false);
		expect(isDue({ kind: 'price_drop', variantId: null, price: 1000 }, null)).toBe(false);
		expect(dueConditions({ ...product, status: 'draft' })).toEqual([]);
		expect(dueConditions({ ...product, inStock: true })).toHaveLength(5);
	});

	it('parse ids, build rows and grade labels', () => {
		expect(parseCompareIds('prd_1, prd_2,prd_1', 4)).toEqual({ ok: true, ids: ['prd_1', 'prd_2'] });
		expect(parseCompareIds(undefined, 4)).toMatchObject({ ok: false });
		expect(parseCompareIds('prd_1,prd_2,prd_3', 2)).toMatchObject({ ok: false });
		expect(parseCompareIds('nope', 4)).toMatchObject({ ok: false });
		const attributes = /** @type {any[]} */ ([
			{ id: 'att_2', name: 'NFC', unit: '', comparable: true, sort: 2 },
			{ id: 'att_1', name: 'RAM', unit: '', comparable: true, sort: 1 },
			{ id: 'att_3', name: 'Colour', unit: '', comparable: true, sort: 1 },
			{ id: 'att_4', name: 'Hidden', unit: '', comparable: false, sort: 0 },
		]);
		expect(compareRows([product, { specs: {} }], attributes)).toEqual([
			{ attributeId: 'att_1', name: 'RAM', unit: '', values: ['6 GB', null] },
			{ attributeId: 'att_2', name: 'NFC', unit: '', values: [true, null] },
		]);
		const graded = {
			variants: [
				{ active: true, grade: 'b' },
				{ active: true, grade: 'a' },
				{ active: false, grade: 'c' },
			],
		};
		expect(gradeLabels(/** @type {any} */ (graded), [{ key: 'a', label: 'Like new' }, { key: 'b' }, { key: 'c' }])).toEqual([
			'Like new',
			'b',
		]);
	});
});

describe('reports and pages', () => {
	it('parse ranges', () => {
		expect(parseRange({}, NOW)).toMatchObject({ ok: true });
		expect(parseRange({ from: '2026-10-01', to: '2026-10-01' }, NOW)).toEqual({
			ok: true,
			range: { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') },
		});
		expect(parseRange({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T12:00:00+00:00' }, NOW)).toMatchObject({ ok: true });
		expect(parseRange({ to: 'x' }, NOW)).toMatchObject({ field: 'to' });
		expect(parseRange({ to: 5 }, NOW)).toMatchObject({ field: 'to' });
		expect(parseRange({ from: '2026-13-45' }, NOW)).toMatchObject({ field: 'from' });
		expect(parseRange({ from: '2026-10-01T99:00:00Z' }, NOW)).toMatchObject({ field: 'from' });
		expect(parseRange({ from: '2026-10-05', to: '2026-10-01' }, NOW)).toMatchObject({ field: 'from' });
		expect(parseRange({ from: '2024-01-01', to: '2026-01-01' }, NOW)).toMatchObject({ field: 'from' });
	});

	it('build stock age and return rate rows', () => {
		const rows = stockAgeRows(
			[
				{
					id: 'p1',
					name: 'A',
					variants: [{ stock: 2, active: true }],
					publishedAt: null,
					createdAt: new Date(NOW - 3 * DAY_MS),
				},
				{ id: 'p2', name: 'B', variants: [{ stock: 0, active: true }], publishedAt: new Date(NOW), createdAt: new Date(NOW) },
				{
					id: 'p3',
					name: 'C',
					variants: [{ stock: 1, active: true }],
					publishedAt: new Date(NOW - 9 * DAY_MS),
					createdAt: new Date(NOW),
				},
			],
			new Map([['p3', new Date(NOW - DAY_MS)]]),
			NOW,
		);
		expect(rows.map((row) => [row.productId, row.daysSinceSale, row.daysListed])).toEqual([
			['p1', 3, 3],
			['p3', 1, 9],
		]);
		const rates = returnRateRows(
			[{ _id: 'p1', name: 'A', units: 4 }],
			[
				{
					orderId: 'o',
					lines: [
						{ lineId: 'l1', quantity: 1 },
						{ lineId: 'l2', quantity: 1 },
						{ lineId: 'lx', quantity: 1 },
					],
				},
			],
			new Map([
				['l1', { productId: 'p1', name: 'A' }],
				['l2', { productId: 'p2', name: 'B' }],
			]),
		);
		expect(rates).toEqual([
			{ productId: 'p1', name: 'A', sold: 4, claimed: 1, rate: 0.25 },
			{ productId: 'p2', name: 'B', sold: 0, claimed: 1, rate: null },
		]);
	});

	it('continue keyset pages', () => {
		/** @type {import('../core/extras-pages.js').SortField[]} */
		const fields = [
			{ field: 'rating', direction: 1 },
			{ field: 'createdAt', direction: -1, date: true },
		];
		expect(sortOf(fields)).toEqual({ rating: 1, createdAt: -1 });
		expect(keyOf(fields, { rating: 4, createdAt: new Date(NOW) })).toEqual([4, new Date(NOW).toISOString()]);
		expect(afterFilter(fields, null)).toEqual({});
		expect(afterFilter(fields, [4, 'nope'])).toEqual({});
		expect(afterFilter(fields, [true, new Date(NOW).toISOString()])).toEqual({});
		expect(afterFilter(fields, [4, new Date(NOW).toISOString()])).toEqual({
			$or: [{ rating: { $gt: 4 } }, { rating: 4, createdAt: { $lt: new Date(NOW) } }],
		});
	});
});
