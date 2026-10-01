/**
 * Navigation blocks: category and brand cards, the mobile tab bar and the contact footer. Their content is the
 * merchant's own (labels, links, contacts), configured per website; nothing about a store is assumed.
 */
import { first, objects, oneOf, safeUrl, str } from './util.js';

/** Icons the tab bar ships (inline SVG, no icon font). */
export const ICONS = Object.freeze(
	/** @type {const} */ (['home', 'search', 'tag', 'cart', 'user', 'chat', 'heart', 'menu', 'grid', 'phone']),
);

/**
 * Navigation cards from configuration or JSON records (`title|name`, `url|href`, `image|logo`, `count`).
 * @param {unknown} records
 * @param {number} max
 * @returns {Array<{ id: string, title: string, href: string | null, image: string | null, count: number | null }>}
 */
export const navCards = (records, max) =>
	objects(records, max)
		.map((record, index) => {
			const count = first(record, 'count|items');
			return {
				id: str(first(record, 'id|slug|key'), String(index), 64) || String(index),
				title: str(first(record, 'title|name|label'), '', 120),
				href: safeUrl(first(record, 'url|href|link')),
				image: safeUrl(first(record, 'image|logo|imageUrl'), { src: true }),
				count: Number.isSafeInteger(count) ? /** @type {number} */ (count) : null,
			};
		})
		.filter((card) => card.title !== '' || card.image !== null);

/**
 * Tabs of the mobile tab bar (2–6). A label comes from the string `mobile_tab_bar.tab.<key>` when the catalog has
 * one (translatable), else from the tab's own `label`.
 * @param {unknown} value
 * @param {(key: string) => string | null} label
 * @returns {Array<{ key: string, href: string, icon: typeof ICONS[number], label: string }>}
 */
export const tabsOf = (value, label) =>
	objects(value, 6)
		.filter((tab) => typeof tab.key === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(tab.key) && safeUrl(tab.href))
		.map((tab) => ({
			key: tab.key,
			href: /** @type {string} */ (safeUrl(tab.href)),
			icon: oneOf(tab.icon, ICONS, 'home'),
			label: label(tab.key) ?? (str(tab.label, '', 40) || tab.key),
		}));

/**
 * The active tab for a path: an exact match for `/`, else the longest matching path prefix (segment-aligned).
 * @param {ReadonlyArray<{ key: string, href: string }>} tabs
 * @param {string} path
 * @returns {string | null}
 */
export const activeTab = (tabs, path) => {
	let best = null;
	let length = -1;
	for (const tab of tabs) {
		if (!tab.href.startsWith('/')) continue;
		const base = tab.href.split(/[?#]/)[0] ?? '/';
		const hit = base === '/' ? path === '/' : path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);
		if (hit && base.length > length) {
			best = tab.key;
			length = base.length;
		}
	}
	return best;
};

/** Contact kinds of the footer. */
export const CONTACT_KINDS = Object.freeze(/** @type {const} */ (['phone', 'email', 'address', 'whatsapp', 'link']));

/**
 * A contact's link: `tel:` keeps digits and a leading `+` (any numbering plan), `mailto:` checks the shape,
 * WhatsApp uses the digits, links must be safe.
 * @param {typeof CONTACT_KINDS[number]} kind
 * @param {string} value
 * @param {unknown} href
 * @returns {string | null}
 */
export const contactHref = (kind, value, href) => {
	const digits = value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
	if (kind === 'phone') return digits.replace('+', '').length >= 3 ? `tel:${digits}` : null;
	if (kind === 'whatsapp') return digits.replace('+', '').length >= 6 ? `https://wa.me/${digits.replace('+', '')}` : null;
	if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : null;
	return safeUrl(href);
};

/**
 * The footer's content.
 * @param {Record<string, unknown>} config
 */
export const footerOf = (config) => ({
	name: str(config.business_name, '', 120),
	contacts: objects(config.contacts, 12)
		.map((contact) => {
			const kind = oneOf(contact.kind, CONTACT_KINDS, 'link');
			const value = str(contact.value, '', 300);
			return { kind, label: str(contact.label, '', 60), value, href: contactHref(kind, value, contact.href) };
		})
		.filter((contact) => contact.value !== ''),
	hours: objects(config.hours, 14)
		.map((row) => ({ days: str(row.days, '', 60), time: str(row.time, '', 60) }))
		.filter((row) => row.days !== ''),
	socials: objects(config.socials, 12)
		.map((social) => ({ label: str(social.label, '', 40), href: safeUrl(social.href) }))
		.filter((social) => social.label !== '' && social.href !== null),
	links: objects(config.links, 20)
		.map((link) => ({ label: str(link.label, '', 60), href: safeUrl(link.href) }))
		.filter((link) => link.label !== '' && link.href !== null),
	year: config.show_year !== false,
});
