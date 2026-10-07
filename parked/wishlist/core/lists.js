/**
 * Lists and their entries (pure). Ported from ibrahimMobiles `packages/shared/src/wishlist.ts`: entries are kept newest
 * first, deduplicated (first occurrence wins), capped by evicting the oldest, and a guest list merges into the account
 * list as a union, newest first, capped. Generalised: any item (id + variant + snapshot), several named lists, the cap
 * and the full-list behaviour are settings, and merging can keep guest lists as their own lists.
 * @module
 */
import { cleanText, itemKeyOf } from './item.js';

/**
 * @typedef {import('./item.js').Item} Item
 * @typedef {import('./item.js').Money} Money
 * @typedef {object} Entry
 * @property {string} id
 * @property {string} key `itemId` or `itemId#variantId`
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} title
 * @property {string | null} image
 * @property {string | null} url
 * @property {Money | null} price latest known price (snapshot, then price.changed@1)
 * @property {Money | null} savedPrice the price when the shopper saved it
 * @property {boolean | null} inStock latest known availability (inventory.changed@1), null = unknown
 * @property {string} addedAt ISO-8601
 * @property {Money | null} [signalPrice] the price of the last price-drop signal
 * @property {string | null} [signaledAt] ISO-8601 of the last signal
 */

/**
 * A new entry for an item.
 * @param {Item} item
 * @param {{ id: string, now: number }} options
 * @returns {Entry}
 */
export const newEntry = (item, { id, now }) => ({
	id,
	key: itemKeyOf(item),
	itemId: item.itemId,
	variantId: item.variantId,
	title: item.title,
	image: item.image,
	url: item.url,
	price: item.price,
	savedPrice: item.price,
	inStock: null,
	addedAt: new Date(now).toISOString(),
	signalPrice: null,
	signaledAt: null,
});

/** @param {Entry} a @param {Entry} b */
const newestFirst = (a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0);

/**
 * Add an item to a list's entries. An item already saved keeps its place, id, date and saved price; its snapshot is
 * refreshed with what was sent. A full list evicts its oldest entries or refuses.
 * @param {readonly Entry[]} entries
 * @param {Entry} entry
 * @param {{ max: number, whenFull: 'evict_oldest' | 'refuse' }} limits
 * @returns {{ ok: true, entries: Entry[], entry: Entry, added: boolean, evicted: Entry[] } | { ok: false, code: 'limit_reached' }}
 */
export const addEntry = (entries, entry, { max, whenFull }) => {
	const existing = entries.find((e) => e.key === entry.key);
	if (existing) {
		const updated = {
			...existing,
			title: entry.title ?? existing.title,
			image: entry.image ?? existing.image,
			url: entry.url ?? existing.url,
			price: entry.price ?? existing.price,
		};
		return { ok: true, entries: entries.map((e) => (e === existing ? updated : e)), entry: updated, added: false, evicted: [] };
	}
	if (entries.length >= max && whenFull === 'refuse') return { ok: false, code: 'limit_reached' };
	const sorted = [...entries].sort(newestFirst);
	const keep = sorted.slice(0, Math.max(0, max - 1));
	const kept = new Set(keep);
	return {
		ok: true,
		entries: [entry, ...entries.filter((e) => kept.has(e))],
		entry,
		added: true,
		evicted: sorted.filter((e) => !kept.has(e)),
	};
};

/**
 * Remove an entry by id.
 * @param {readonly Entry[]} entries
 * @param {string} entryId
 */
export const removeEntry = (entries, entryId) => {
	const next = entries.filter((e) => e.id !== entryId);
	return { entries: next, removed: next.length !== entries.length };
};

/**
 * Union of two entry lists: newest first, first occurrence of a key wins (the account's own entry over the guest's),
 * capped to the newest `max`.
 * @param {readonly Entry[]} account
 * @param {readonly Entry[]} incoming
 * @param {number} max
 * @returns {{ entries: Entry[], added: number }}
 */
export const mergeEntries = (account, incoming, max) => {
	const seen = new Set();
	/** @type {Entry[]} */
	const out = [];
	for (const entry of [...account, ...incoming]) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		out.push(entry);
	}
	const entries = out.sort(newestFirst).slice(0, max);
	const before = new Set(account.map((e) => e.key));
	return { entries, added: entries.filter((e) => !before.has(e.key)).length };
};

/**
 * A list name: cleaned and capped, null when empty.
 * @param {unknown} value
 * @param {number} max
 */
export const listName = (value, max) => cleanText(value, max);

/**
 * @typedef {{ id: string, name: string, isDefault: boolean, items: Entry[], createdOn: string }} ListLike
 */

/**
 * How guest lists join a customer's lists on sign-in.
 * - `into_default`: every guest entry joins the customer's target list (their default list).
 * - `keep_lists`: the guest's default list joins the target list; each other guest list becomes a new customer list
 *   while the customer has room (a name the customer already uses, or no room, joins the target list).
 * @param {{ guest: readonly ListLike[], customer: readonly ListLike[], targetId: string,
 *   strategy: 'into_default' | 'keep_lists', maxLists: number, maxItems: number }} input `customer` includes the target
 * @returns {{ defaultEntries: Entry[], newLists: Array<{ name: string, entries: Entry[] }>, added: number }}
 */
export const planMerge = ({ guest, customer, targetId, strategy, maxLists, maxItems }) => {
	const current = customer.find((list) => list.id === targetId)?.items ?? [];
	const names = new Set(customer.map((list) => list.name.toLowerCase()));
	let room = maxLists - customer.length;
	/** @type {Entry[]} */
	const intoTarget = [];
	/** @type {Array<{ name: string, entries: Entry[] }>} */
	const newLists = [];
	const ordered = [...guest].sort((a, b) => (a.createdOn < b.createdOn ? -1 : a.createdOn > b.createdOn ? 1 : 0));
	for (const list of ordered) {
		const own = strategy === 'keep_lists' && !list.isDefault && list.items.length > 0;
		if (own && room > 0 && !names.has(list.name.toLowerCase())) {
			names.add(list.name.toLowerCase());
			room -= 1;
			newLists.push({ name: list.name, entries: mergeEntries([], list.items, maxItems).entries });
		} else intoTarget.push(...list.items);
	}
	const merged = mergeEntries(current, intoTarget, maxItems);
	return {
		defaultEntries: merged.entries,
		newLists,
		added: merged.added + newLists.reduce((sum, list) => sum + list.entries.length, 0),
	};
};
