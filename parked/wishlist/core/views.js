/**
 * API views of stored documents (pure): what each audience may see. Owners see their lists and entries; server keys
 * also see who owns a list; a share view shows the list's name and items only — no owner, no ids of the list or its
 * entries, no saved prices, no signal state.
 * @module
 */

/**
 * @typedef {import('./lists.js').Entry} Entry
 * @typedef {object} StoredList
 * @property {string} id
 * @property {'customer' | 'guest'} ownerKind
 * @property {string} ownerId
 * @property {string} name
 * @property {boolean} isDefault
 * @property {boolean} notify the owner opted in to price-drop / back-in-stock signals
 * @property {Entry[]} items
 * @property {string} createdOn ISO-8601
 * @property {string} touchedOn ISO-8601
 * @property {{ tokenHash: string, createdOn: string, expiresOn: string | null } | null} [share]
 */

/**
 * @param {Entry} entry
 */
export const entryView = (entry) => ({
	id: entry.id,
	itemId: entry.itemId,
	variantId: entry.variantId,
	title: entry.title,
	image: entry.image,
	url: entry.url,
	price: entry.price,
	savedPrice: entry.savedPrice,
	inStock: entry.inStock,
	addedAt: entry.addedAt,
});

/**
 * @param {StoredList} list
 * @param {{ items?: boolean, reveal?: boolean, now?: number }} [options] `reveal`: owner id (server keys)
 */
export const listView = (list, { items = false, reveal = false, now = Date.now() } = {}) => ({
	id: list.id,
	name: list.name,
	isDefault: list.isDefault === true,
	itemCount: list.items.length,
	notify: list.notify === true,
	shared: Boolean(list.share && (list.share.expiresOn === null || Date.parse(list.share.expiresOn) > now)),
	owner: reveal ? { kind: list.ownerKind, id: list.ownerId } : { kind: list.ownerKind },
	createdAt: list.createdOn,
	updatedAt: list.touchedOn,
	...(items ? { items: list.items.map(entryView) } : {}),
});

/**
 * The read-only view behind a share link.
 * @param {StoredList} list
 * @param {{ showPrices: boolean }} options
 */
export const sharedView = (list, { showPrices }) => ({
	name: list.name,
	itemCount: list.items.length,
	items: list.items.map((entry) => ({
		itemId: entry.itemId,
		variantId: entry.variantId,
		title: entry.title,
		image: entry.image,
		url: entry.url,
		price: showPrices ? entry.price : null,
		inStock: entry.inStock,
	})),
});

/**
 * @param {{ id: string, kind: string, itemId: string, variantId: string | null, ownerId: string, listIds: string[],
 *   at: string, eventId: string }} record
 */
export const notificationView = (record) => ({
	id: record.id,
	kind: record.kind,
	itemId: record.itemId,
	variantId: record.variantId,
	customer: { subject: record.ownerId },
	listIds: record.listIds,
	eventId: record.eventId,
	at: record.at,
});
