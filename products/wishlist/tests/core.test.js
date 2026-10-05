import { describe, expect, it } from 'vitest';
import { effectiveConfig } from '../core/config.js';
import { cleanText, isRef, itemKeyOf, linkOf, moneyOf, parseItem } from '../core/item.js';
import { addEntry, listName, mergeEntries, newEntry, planMerge, removeEntry } from '../core/lists.js';
import { formatMoney } from '../core/money.js';
import {
	coolingDown,
	dropOf,
	isRestock,
	priceChangeOf,
	priceSignals,
	stockChangeOf,
	stockSignals,
	touches,
} from '../core/signals.js';
import { createTranslator } from '../core/text.js';
import { entryView, listView, notificationView, sharedView } from '../core/views.js';
import { settingsFrom } from '../api/settings.js';

const T = Date.parse('2026-10-01T10:00:00Z');
const policy = {
	urlPolicy: /** @type {const} */ ('same_site'),
	imagePolicy: /** @type {const} */ ('any_https'),
	domain: 'shop.example.com',
	allowSubdomains: true,
};
const eur = (/** @type {number} */ amount) => ({ amount, currency: 'EUR' });
/** @param {string} itemId @param {number} at @param {Record<string, unknown>} [patch] */
const entry = (itemId, at, patch = {}) => ({
	...newEntry(
		{ itemId, variantId: null, title: itemId, image: null, url: null, price: eur(1000) },
		{ id: `wli_${itemId}`, now: at },
	),
	...patch,
});

describe('items', () => {
	it('validates ids and keys items by id and variant', () => {
		expect(isRef('itm_1')).toBe(true);
		expect(isRef('sku:ABC/9+x@v2')).toBe(true);
		expect(isRef('has space')).toBe(false);
		expect(isRef('a#b')).toBe(false);
		expect(isRef('x'.repeat(129))).toBe(false);
		expect(itemKeyOf({ itemId: 'a' })).toBe('a');
		expect(itemKeyOf({ itemId: 'a', variantId: 'b' })).toBe('a#b');
	});

	it('cleans snapshot text and money', () => {
		expect(cleanText('  Linen\u0000  shirt‮  ', 200)).toBe('Linen shirt');
		expect(cleanText('éèê', 2)).toBe('éè');
		expect(cleanText('   ', 10)).toBeNull();
		expect(cleanText(5, 10)).toBeNull();
		expect(moneyOf(undefined)).toBeNull();
		expect(moneyOf(eur(1))).toEqual(eur(1));
		expect(moneyOf({ amount: 1.5, currency: 'EUR' })).toBeUndefined();
		expect(moneyOf({ amount: -1, currency: 'EUR' })).toBeUndefined();
		expect(moneyOf({ amount: 1, currency: 'eur' })).toBeUndefined();
		expect(moneyOf('1 EUR')).toBeUndefined();
	});

	it('accepts links under the website policy only', () => {
		const site = { domain: 'shop.example.com', allowSubdomains: false };
		expect(linkOf('https://shop.example.com/p/1', { policy: 'same_site', ...site })).toBe('https://shop.example.com/p/1');
		expect(linkOf('https://m.shop.example.com/p/1', { policy: 'same_site', ...site })).toBeNull();
		expect(
			linkOf('https://m.shop.example.com/p/1', { policy: 'same_site', domain: 'shop.example.com', allowSubdomains: true }),
		).not.toBeNull();
		expect(linkOf('https://evil.test/p', { policy: 'same_site', ...site })).toBeNull();
		expect(linkOf('https://evil.test/p', { policy: 'any_https', ...site })).toBe('https://evil.test/p');
		expect(linkOf('http://shop.example.com/p', { policy: 'any_https', ...site })).toBeNull();
		expect(linkOf('https://u:p@shop.example.com/', { policy: 'any_https', ...site })).toBeNull();
		expect(linkOf('javascript:alert(1)', { policy: 'any_https', ...site })).toBeNull();
		expect(linkOf('not a url', { policy: 'any_https', ...site })).toBeNull();
		expect(linkOf('https://shop.example.com/', { policy: 'none', ...site })).toBeNull();
		expect(linkOf('https://shop.example.com/', { policy: 'same_site', domain: null })).toBeNull();
	});

	it('parses an item: strict ids, cleaned snapshot, refused links dropped, bad prices refused', () => {
		const ok = parseItem(
			{
				itemId: 'itm_1',
				variantId: 'v_1',
				title: ' Shirt ',
				image: 'https://cdn.test/a.jpg',
				url: 'https://evil.test/',
				price: eur(10),
				extra: 1,
			},
			policy,
		);
		expect(ok).toEqual({
			ok: true,
			item: { itemId: 'itm_1', variantId: 'v_1', title: 'Shirt', image: 'https://cdn.test/a.jpg', url: null, price: eur(10) },
		});
		expect(parseItem({ itemId: 'itm_1' }, policy)).toMatchObject({
			ok: true,
			item: { variantId: null, price: null, title: null },
		});
		expect(parseItem(null, policy)).toEqual({ ok: false, errors: [{ path: '/', code: 'invalid' }] });
		expect(parseItem({ variantId: 'bad id', price: { amount: 'x' } }, policy, '/item')).toEqual({
			ok: false,
			errors: [
				{ path: '/item/itemId', code: 'required' },
				{ path: '/item/variantId', code: 'invalid' },
				{ path: '/item/price', code: 'invalid' },
			],
		});
		expect(parseItem({ itemId: 'a b' }, policy)).toMatchObject({ ok: false, errors: [{ path: '/itemId', code: 'invalid' }] });
	});
});

describe('lists', () => {
	it('adds newest first, refreshes an existing entry and evicts or refuses when full', () => {
		const a = entry('a', T);
		const b = entry('b', T + 1000);
		let result = addEntry([], a, { max: 2, whenFull: 'evict_oldest' });
		expect(result).toMatchObject({ ok: true, added: true, evicted: [] });
		result = addEntry(result.ok ? result.entries : [], b, { max: 2, whenFull: 'evict_oldest' });
		const two = result.ok ? result.entries : [];
		expect(two.map((e) => e.itemId)).toEqual(['b', 'a']);
		const again = addEntry(
			two,
			{ ...entry('a', T + 5000), title: 'New title', price: eur(900), image: null },
			{ max: 2, whenFull: 'refuse' },
		);
		expect(again).toMatchObject({
			ok: true,
			added: false,
			entry: { id: 'wli_a', title: 'New title', price: eur(900), savedPrice: eur(1000) },
		});
		const full = addEntry(two, entry('c', T + 9000), { max: 2, whenFull: 'refuse' });
		expect(full).toEqual({ ok: false, code: 'limit_reached' });
		const evicted = addEntry(two, entry('c', T + 9000), { max: 2, whenFull: 'evict_oldest' });
		expect(evicted.ok && evicted.entries.map((e) => e.itemId)).toEqual(['c', 'b']);
		expect(evicted.ok && evicted.evicted.map((e) => e.itemId)).toEqual(['a']);
	});

	it('removes entries and merges newest first with the account winning', () => {
		const list = [entry('a', T), entry('b', T + 1)];
		expect(removeEntry(list, 'wli_a')).toMatchObject({ removed: true, entries: [{ itemId: 'b' }] });
		expect(removeEntry(list, 'nope').removed).toBe(false);
		const account = [entry('a', T, { title: 'mine' })];
		const guest = [entry('a', T + 10, { title: 'guest' }), entry('c', T + 20), entry('d', T + 5)];
		const merged = mergeEntries(account, guest, 2);
		expect(merged.entries.map((e) => `${e.itemId}:${e.title}`)).toEqual(['c:c', 'd:d']);
		expect(mergeEntries(account, guest, 10)).toMatchObject({ added: 2 });
		expect(mergeEntries(account, guest, 10).entries.find((e) => e.itemId === 'a')?.title).toBe('mine');
		expect(listName('  Gifts  ', 3)).toBe('Gif');
		expect(listName('', 3)).toBeNull();
	});

	it('plans a merge into the default list or as separate lists', () => {
		const customer = [{ id: 'wl_c', name: 'Wishlist', isDefault: true, items: [entry('a', T)], createdOn: 'x' }];
		const guest = [
			{ id: 'wl_g1', name: 'Wishlist', isDefault: true, items: [entry('b', T + 1)], createdOn: '2026-01-02' },
			{ id: 'wl_g2', name: 'Gifts', isDefault: false, items: [entry('c', T + 2)], createdOn: '2026-01-01' },
			{ id: 'wl_g3', name: 'wishlist', isDefault: false, items: [entry('d', T + 3)], createdOn: '2026-01-03' },
			{ id: 'wl_g4', name: 'Empty', isDefault: false, items: [], createdOn: '2026-01-03' },
		];
		const into = planMerge({ guest, customer, targetId: 'wl_c', strategy: 'into_default', maxLists: 5, maxItems: 10 });
		expect(into.newLists).toEqual([]);
		expect(into.defaultEntries.map((e) => e.itemId)).toEqual(['d', 'c', 'b', 'a']);
		expect(into.added).toBe(3);
		const keep = planMerge({ guest, customer, targetId: 'wl_c', strategy: 'keep_lists', maxLists: 5, maxItems: 10 });
		expect(keep.newLists.map((l) => l.name)).toEqual(['Gifts']);
		expect(keep.defaultEntries.map((e) => e.itemId)).toEqual(['d', 'b', 'a']);
		expect(keep.added).toBe(3);
		const noRoom = planMerge({ guest, customer, targetId: 'wl_c', strategy: 'keep_lists', maxLists: 1, maxItems: 10 });
		expect(noRoom.newLists).toEqual([]);
		expect(
			planMerge({ guest: [], customer: [], targetId: 'none', strategy: 'into_default', maxLists: 1, maxItems: 1 }),
		).toEqual({
			defaultEntries: [],
			newLists: [],
			added: 0,
		});
	});
});

describe('signals', () => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) }).signals;

	it('parses price and stock changes', () => {
		expect(priceChangeOf({ itemId: 'a', price: eur(5), previousPrice: eur(6), variantId: 'v' })).toEqual({
			kind: 'price',
			itemId: 'a',
			variantId: 'v',
			price: eur(5),
			previousPrice: eur(6),
		});
		expect(priceChangeOf({ itemId: 'a', price: eur(5), previousPrice: 'x' })).toMatchObject({
			previousPrice: null,
			variantId: null,
		});
		expect(priceChangeOf({ itemId: 'a' })).toBeNull();
		expect(priceChangeOf(null)).toBeNull();
		expect(stockChangeOf({ itemId: 'a', quantity: 4, previousQuantity: 0, available: 3, locationId: 'loc_1' })).toEqual({
			kind: 'stock',
			itemId: 'a',
			variantId: null,
			locationId: 'loc_1',
			available: 3,
			previous: 0,
		});
		expect(stockChangeOf({ itemId: 'a', quantity: 2 })).toMatchObject({ available: 2, previous: null });
		expect(stockChangeOf({ itemId: 'a', quantity: 1.5 })).toBeNull();
		expect(stockChangeOf({ itemId: 'bad id', quantity: 1 })).toBeNull();
	});

	it('decides drops, restocks, cool-downs and which entries a change touches', () => {
		expect(dropOf({ reference: eur(1000), price: eur(900), minPercent: 5, minAmount: 0 })).toEqual({
			dropped: true,
			percent: 10,
		});
		expect(dropOf({ reference: eur(1000), price: eur(990), minPercent: 5, minAmount: 0 })).toEqual({
			dropped: false,
			percent: 1,
		});
		expect(dropOf({ reference: eur(1000), price: eur(900), minPercent: 0, minAmount: 200 }).dropped).toBe(false);
		expect(dropOf({ reference: eur(1000), price: eur(1000), minPercent: 0, minAmount: 0 }).dropped).toBe(false);
		expect(dropOf({ reference: { amount: 1000, currency: 'USD' }, price: eur(1), minPercent: 0, minAmount: 0 }).dropped).toBe(
			false,
		);
		expect(dropOf({ reference: null, price: eur(1), minPercent: 0, minAmount: 0 }).dropped).toBe(false);
		const change = {
			kind: /** @type {const} */ ('stock'),
			itemId: 'a',
			variantId: null,
			locationId: null,
			available: 3,
			previous: 0,
		};
		expect(isRestock(change, null, 1)).toBe(true);
		expect(isRestock({ ...change, previous: null }, 0, 1)).toBe(true);
		expect(isRestock({ ...change, previous: null }, null, 1)).toBe(false);
		expect(isRestock({ ...change, previous: 2 }, null, 1)).toBe(false);
		expect(isRestock(change, null, 5)).toBe(false);
		const e = entry('a', T, { signaledAt: new Date(T).toISOString() });
		expect(coolingDown(e, T + 3_600_000, 24)).toBe(true);
		expect(coolingDown(e, T + 25 * 3_600_000, 24)).toBe(false);
		expect(coolingDown(entry('a', T), T, 24)).toBe(false);
		expect(touches(entry('a', T), { itemId: 'a', variantId: 'v' })).toBe(true);
		expect(touches(entry('a', T, { variantId: 'w' }), { itemId: 'a', variantId: 'v' })).toBe(false);
		expect(touches(entry('a', T, { variantId: 'w' }), { itemId: 'a', variantId: null })).toBe(true);
		expect(touches(entry('b', T), { itemId: 'a', variantId: null })).toBe(false);
	});

	it('groups signals per customer over opted-in lists', () => {
		const lists = [
			{ id: 'l1', ownerId: 'c1', notify: true, items: [entry('a', T), entry('b', T)] },
			{ id: 'l2', ownerId: 'c1', notify: true, items: [entry('a', T, { id: 'wli_a2' })] },
			{ id: 'l3', ownerId: 'c2', notify: false, items: [entry('a', T)] },
			{ id: 'l4', ownerId: 'c3', notify: true, items: [entry('a', T, { signalPrice: eur(800) })] },
			{ id: 'l5', ownerId: 'c4', notify: true, items: [entry('a', T, { signaledAt: new Date(T).toISOString() })] },
		];
		const change = { kind: /** @type {const} */ ('price'), itemId: 'a', variantId: null, price: eur(800), previousPrice: null };
		const signals = priceSignals({ lists, change, settings, now: T + 3_600_000 });
		expect(signals).toEqual([
			{
				ownerId: 'c1',
				listIds: ['l1', 'l2'],
				entryIds: ['wli_a', 'wli_a2'],
				entry: lists[0]?.items[0],
				reference: eur(1000),
				percent: 20,
			},
		]);
		expect(priceSignals({ lists, change, settings: { ...settings, priceDrops: false }, now: T })).toEqual([]);
		const stock = {
			kind: /** @type {const} */ ('stock'),
			itemId: 'a',
			variantId: null,
			locationId: null,
			available: 1,
			previous: 0,
		};
		expect(stockSignals({ lists, change: stock, settings, now: T + 3_600_000 }).map((s) => s.ownerId)).toEqual(['c1', 'c3']);
		expect(stockSignals({ lists, change: stock, settings: { ...settings, backInStock: false }, now: T })).toEqual([]);
	});
});

describe('views, config, text and money', () => {
	const stored = {
		id: 'wl_1',
		ownerKind: /** @type {const} */ ('customer'),
		ownerId: 'cus_1',
		name: 'Gifts',
		isDefault: true,
		notify: true,
		items: [entry('a', T)],
		createdOn: '2026-10-01T10:00:00.000Z',
		touchedOn: '2026-10-01T10:00:00.000Z',
		share: { tokenHash: 'h', createdOn: 'x', expiresOn: '2026-10-02T10:00:00.000Z' },
	};

	it('shows lists to owners, servers and share viewers', () => {
		expect(listView(stored, { now: T })).toMatchObject({ id: 'wl_1', itemCount: 1, shared: true, owner: { kind: 'customer' } });
		expect(listView(stored, { now: T + 2 * 86_400_000 }).shared).toBe(false);
		expect(listView({ ...stored, share: null }).shared).toBe(false);
		expect(listView(stored, { reveal: true, items: true, now: T })).toMatchObject({
			owner: { id: 'cus_1' },
			items: [{ itemId: 'a' }],
		});
		expect(Object.keys(entryView(stored.items[0] ?? entry('x', T)))).not.toContain('signalPrice');
		const shared = sharedView(stored, { showPrices: false });
		expect(shared).toEqual({
			name: 'Gifts',
			itemCount: 1,
			items: [{ itemId: 'a', variantId: null, title: 'a', image: null, url: null, price: null, inStock: null }],
		});
		expect(JSON.stringify(shared)).not.toContain('cus_1');
		expect(sharedView(stored, { showPrices: true }).items[0]?.price).toEqual(eur(1000));
		expect(
			notificationView({
				id: 'n',
				kind: 'back_in_stock',
				itemId: 'a',
				variantId: null,
				ownerId: 'c',
				listIds: ['l'],
				at: 'x',
				eventId: 'e',
			}),
		).toEqual({
			id: 'n',
			kind: 'back_in_stock',
			itemId: 'a',
			variantId: null,
			customer: { subject: 'c' },
			listIds: ['l'],
			eventId: 'e',
			at: 'x',
		});
	});

	it('overlays only well-typed, allowed values on schema defaults', () => {
		const schema = {
			properties: {
				n: { type: 'integer', default: 1 },
				s: { type: 'string', default: 'a', enum: ['a', 'b'] },
				f: { type: 'boolean', default: false },
				l: { type: 'array', default: ['x'] },
				o: { default: null },
			},
		};
		expect(effectiveConfig(schema, { n: 2, s: 'b', f: true, l: [], o: 3 })).toEqual({ n: 2, s: 'b', f: true, l: [], o: 3 });
		expect(effectiveConfig(schema, { n: 1.5, s: 'c', f: 'yes', l: 'x' })).toEqual({
			n: 1,
			s: 'a',
			f: false,
			l: ['x'],
			o: null,
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});

	it('translates and formats money in the currency’s own decimals', () => {
		const t = createTranslator({ hi: 'Hi {name} {missing}' });
		expect(t('hi', { name: 'Ada' })).toBe('Hi Ada {missing}');
		expect(t('nope')).toBe('nope');
		expect(formatMoney(eur(4900), 'en')).toBe('€49.00');
		expect(formatMoney({ amount: 4900, currency: 'JPY' }, 'en')).toBe('¥4,900');
		expect(formatMoney(eur(100), 'not a locale!')).toContain('1.00');
		expect(formatMoney(null, 'en')).toBe('');
	});
});
