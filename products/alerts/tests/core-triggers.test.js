import { describe, expect, it } from 'vitest';
import {
	ANY_LOCATION,
	applyChange,
	csvRowToInput,
	emptyItem,
	fromInventory,
	fromPrice,
	parseCsv,
	stateOf,
	targetOf,
} from '../core/triggers.js';

const options = { threshold: 0, locations: /** @type {string[]} */ ([]), ignoreOutOfOrder: true };
const eur = (/** @type {number} */ amount) => ({ amount, currency: 'EUR' });

describe('changes', () => {
	it('reads targets and event data', () => {
		expect(targetOf({ itemId: 'itm_1' })).toEqual({ itemId: 'itm_1' });
		expect(targetOf({ itemId: 'itm_1', variantId: 'v1' })).toEqual({ itemId: 'itm_1', variantId: 'v1' });
		expect(targetOf({ itemId: 'itm_1', variantId: 'bad id' })).toBeNull();
		expect(targetOf({ itemId: 'itm_1', variantId: null })).toEqual({ itemId: 'itm_1' });
		expect(targetOf({})).toBeNull();
		expect(fromInventory({ itemId: 'itm_1', quantity: 5, previousQuantity: 0, locationId: 'loc_a' }, 1)).toEqual({
			kind: 'inventory',
			target: { itemId: 'itm_1' },
			locationId: 'loc_a',
			quantity: 5,
			previousQuantity: 0,
			at: 1,
		});
		expect(fromInventory({ itemId: 'itm_1', quantity: 1.5 }, 1)).toBeNull();
		expect(fromInventory({ quantity: 1 }, 1)).toBeNull();
		expect(fromPrice({ itemId: 'itm_1', price: eur(5), previousPrice: eur(9) }, 2)).toEqual({
			kind: 'price',
			target: { itemId: 'itm_1' },
			price: eur(5),
			previousPrice: eur(9),
			at: 2,
		});
		expect(fromPrice({ itemId: 'itm_1', price: { amount: 'x' } }, 2)).toBeNull();
		expect(fromPrice({ itemId: 'itm_1', price: eur(1) }, 2)).not.toHaveProperty('previousPrice');
	});

	it('folds stock per location (before / after, previous quantity, stale, untracked)', () => {
		const change = /** @type {any} */ (fromInventory({ itemId: 'itm_1', quantity: 5, previousQuantity: 0 }, 10));
		const first = applyChange(null, change, options);
		expect(first).toMatchObject({
			ok: true,
			before: { quantity: 0, available: false },
			after: { quantity: 5, available: true },
		});
		if (!first.ok) throw new Error('fold failed');
		const unknown = applyChange(null, { ...change, previousQuantity: undefined }, options);
		expect(unknown).toMatchObject({ ok: true, before: {}, after: { quantity: 5 } });
		const later = applyChange(first.next, { ...change, quantity: 0, at: 20 }, options);
		expect(later).toMatchObject({
			ok: true,
			before: { quantity: 5, available: true },
			after: { quantity: 0, available: false },
		});
		expect(applyChange(first.next, { ...change, at: 5 }, options)).toEqual({ ok: false, reason: 'stale' });
		expect(applyChange(first.next, { ...change, at: 5 }, { ...options, ignoreOutOfOrder: false })).toMatchObject({ ok: true });
		const tracked = { ...options, locations: ['loc_a'] };
		expect(applyChange(null, { ...change, locationId: 'loc_b' }, tracked)).toEqual({ ok: false, reason: 'untracked_location' });
		const a = applyChange(null, { ...change, locationId: 'loc_a', quantity: 2 }, tracked);
		if (!a.ok) throw new Error('fold failed');
		const b = applyChange(a.next, { ...change, locationId: ANY_LOCATION, quantity: 1 }, tracked);
		expect(b).toMatchObject({ ok: true, after: { quantity: 3 } });
		expect(
			stateOf({ ...emptyItem(), locations: { loc_z: { quantity: 9, at: 1 } } }, { threshold: 0, locations: ['loc_a'] }),
		).toEqual({});
	});

	it('folds prices and keeps custom changes neutral', () => {
		const change = /** @type {any} */ (fromPrice({ itemId: 'itm_1', price: eur(800), previousPrice: eur(1000) }, 10));
		const first = applyChange(null, change, options);
		expect(first).toMatchObject({ ok: true, before: { price: eur(1000) }, after: { price: eur(800) } });
		if (!first.ok) throw new Error('fold failed');
		expect(applyChange(first.next, { ...change, at: 1 }, options)).toEqual({ ok: false, reason: 'stale' });
		expect(applyChange(first.next, { ...change, price: eur(700), at: 20 }, options)).toMatchObject({
			before: { price: eur(800) },
			after: { price: eur(700) },
		});
		expect(applyChange(null, { ...change, previousPrice: undefined }, options)).toMatchObject({ before: {} });
		const custom = applyChange(first.next, { kind: 'custom', target: { itemId: '*' }, at: 30 }, options);
		expect(custom).toMatchObject({ ok: true, before: { price: eur(800) }, after: { price: eur(800) } });
	});
});

describe('csv', () => {
	it('parses RFC 4180 text', () => {
		const parsed = parseCsv('Kind,Item_Id,quantity\r\ninventory,"itm,1",5\n\ninventory,"a ""b""",0\n', { maxRows: 10 });
		expect(parsed).toEqual({
			ok: true,
			header: ['kind', 'item_id', 'quantity'],
			rows: [
				['inventory', 'itm,1', '5'],
				['inventory', 'a "b"', '0'],
			],
		});
		expect(parseCsv('item_id\nitm_1', { maxRows: 10 })).toEqual({ ok: true, header: ['item_id'], rows: [['itm_1']] });
		expect(parseCsv('item_id\n', { maxRows: 10 })).toEqual({ ok: false, code: 'csv_empty' });
		expect(parseCsv('', { maxRows: 10 })).toEqual({ ok: false, code: 'csv_empty' });
		expect(parseCsv('item_id\n"open', { maxRows: 10 })).toEqual({ ok: false, code: 'csv_malformed' });
		expect(parseCsv('item_id\nab"c"', { maxRows: 10 })).toEqual({ ok: false, code: 'csv_malformed' });
		expect(parseCsv('item_id\na\nb\nc\n', { maxRows: 2 })).toEqual({ ok: false, code: 'csv_too_many_rows' });
		expect(parseCsv('item_id\na\nb\nc', { maxRows: 2 })).toEqual({ ok: false, code: 'csv_too_many_rows' });
	});

	it('maps rows to trigger bodies', () => {
		const header = [
			'kind',
			'item_id',
			'variant_id',
			'quantity',
			'previous_quantity',
			'price',
			'currency',
			'item_name',
			'item_url',
			'ignored',
		];
		expect(csvRowToInput(header, ['', 'itm_1', 'v1', '5', '0', '', '', 'Phone', '', 'x'])).toEqual({
			kind: 'inventory',
			itemId: 'itm_1',
			variantId: 'v1',
			quantity: 5,
			previousQuantity: 0,
			item: { name: 'Phone', url: undefined },
		});
		expect(csvRowToInput(header, ['', 'itm_2', '', '', '', '1999', 'eur'])).toEqual({
			kind: 'price',
			itemId: 'itm_2',
			price: { amount: 1999, currency: 'EUR' },
		});
		expect(csvRowToInput(['item_id', 'quantity'], ['itm_3', 'many'])).toEqual({ kind: 'inventory', itemId: 'itm_3' });
	});
});
