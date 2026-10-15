/**
 * Ecommerce's own part of the website Setup sheet (owner request 2026-10-14, `ss.blueprint/1`): its lists in its own
 * words — the order flow, couriers, delivery zones, tax rules, grades, item types, booking hours and role prices, by name and
 * number, never an address or a key — and short summaries of what the merchant's website builds around the shop: the
 * pages and their addresses, what the website serves from its own domain, and the SEO tags of its page heads. The
 * adapter (`adapters/product.js`) reads the lists and settings and adds the event types (`core/events.js`). No I/O.
 * @module
 */
import { stopPage } from './alerts.js';
import { SITE_ROUTES } from './snippets.js';

/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./couriers.js').Courier} Courier */
/** @typedef {import('./delivery.js').Zone} Zone */
/** @typedef {import('./taxes.js').TaxRule} TaxRule */
/** @typedef {import('./grades.js').Grade} Grade */
/** @typedef {import('./item-types.js').ItemType} ItemType */
/** @typedef {import('./bookings.js').OpeningHours} OpeningHours */
/** @typedef {import('./role-pricing.js').RolePrice} RolePrice */

/** Longest list summary on the Setup sheet (the kit's limit). */
const LIST_SUMMARY_MAX = 300;
/** Longest name a list summary shows. */
const NAME_MAX = 60;

/** @param {number} count @param {string} one @param {string} many */
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** @param {unknown} value */
const nameOf = (value) => {
	const text = String(value ?? '').trim();
	return text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1)}…` : text;
};

/**
 * A list as `<head>: a, b and 3 more<tail>.`: as many names as fit in a list summary, the rest counted.
 * @param {string} head
 * @param {string[]} names
 * @param {string} [tail]
 */
const listed = (head, names, tail = '') => {
	/** @param {number} shown */
	const text = (shown) =>
		`${head}: ${names.slice(0, shown).join(', ')}${shown < names.length ? ` and ${names.length - shown} more` : ''}${tail}.`;
	let shown = names.length;
	while (shown > 1 && text(shown).length > LIST_SUMMARY_MAX) shown -= 1;
	const out = text(shown);
	return out.length > LIST_SUMMARY_MAX ? `${out.slice(0, LIST_SUMMARY_MAX - 1)}…` : out;
};

/** Weekday names, 0 = Sunday (en-US, as the Portal shows dates). */
const WEEKDAYS = Object.freeze(
	[0, 1, 2, 3, 4, 5, 6].map((day) =>
		// January 4, 2026 is a Sunday
		new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 4 + day)),
	),
);

/**
 * A booking time `HH:MM` as the Portal shows times (`9:00 AM`).
 * @param {string} time
 */
const clockText = (time) => {
	const [hours = 0, minutes = 0] = time.split(':').map(Number);
	return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** The order flow: its statuses by name, its moves and how many statuses message the shopper. @param {OrderFlow} flow */
const flowWords = (flow) => {
	const notify = flow.statuses.filter((status) => status.notify === true).length;
	return listed(
		counted(flow.statuses.length, 'status', 'statuses'),
		flow.statuses.map((status) => nameOf(status.label)),
		`; ${counted(flow.moves.length, 'move', 'moves')}; ${notify === 0 ? 'no status messages' : notify === 1 ? '1 status messages' : `${notify} statuses message`} the shopper`,
	);
};

/**
 * Grades by label with the condition search engines are told, and those no longer offered: each key once, by its entry
 * for every category (else its first entry for one category, E45).
 * @param {Grade[]} grades
 */
const gradeWords = (grades) => {
	/** @type {Map<string, Grade>} */
	const first = new Map();
	for (const grade of grades) if (!first.has(grade.key) || grade.categoryId === null) first.set(grade.key, grade);
	const names = [...first.values()].map((grade) => {
		const notes = [grade.condition, grade.active ? '' : 'not offered'].filter(Boolean);
		return `${nameOf(grade.label)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
	});
	return names.length === 0 ? 'No grades yet.' : listed(counted(names.length, 'grade', 'grades'), names);
};

/**
 * Item types by name with their kind and whether their items have numbered units, and those no longer offered.
 * @param {ItemType[]} types
 */
const typeWords = (types) => {
	if (types.length === 0) return 'No item types yet: every item has the built-in type of its kind.';
	const names = types.map((type) => {
		const notes = [type.kind, type.elements.units ? 'unit numbers' : '', type.active ? '' : 'not offered'].filter(Boolean);
		return `${nameOf(type.name)} (${notes.join(', ')})`;
	});
	return listed(counted(types.length, 'item type', 'item types'), names);
};

/** The booking hours by day (`Mon 9:00 AM–5:00 PM`), Sunday first. @param {OpeningHours[]} hours */
const hoursWords = (hours) => {
	if (hours.length === 0) return 'No booking hours yet, so no slot can be booked.';
	const days = [0, 1, 2, 3, 4, 5, 6]
		.map((day) =>
			hours
				.filter((period) => period.day === day)
				.sort((a, b) => a.from.localeCompare(b.from))
				.map((period) => `${clockText(period.from)}–${clockText(period.to)}`),
		)
		.map((periods, day) => (periods.length > 0 ? `${WEEKDAYS[day]} ${periods.join(' and ')}` : ''))
		.filter(Boolean);
	return listed(`Bookable ${counted(days.length, 'day', 'days')} a week`, days);
};

/**
 * @param {string} one @param {string} many
 * @param {(item: any) => string} name
 * @returns {(items: any[]) => string}
 */
const named = (one, many, name) => (items) =>
	items.length === 0 ? `No ${many} yet.` : listed(counted(items.length, one, many), items.map(name));

/** Each list in Ecommerce's own words (`hooks.blueprint` lists). */
export const LIST_WORDS = Object.freeze({
	order_flow: flowWords,
	payment_methods: named(
		'payment method',
		'payment methods',
		(/** @type {import('./payment-methods.js').PaymentMethodRecord} */ method) =>
			`${nameOf(method.name)} (${method.kind}${method.active ? '' : ', off'})`,
	),
	couriers: named('courier', 'couriers', (/** @type {Courier} */ courier) => nameOf(courier.name)),
	policies: named('policy', 'policies', (/** @type {import('./policies.js').Policy} */ policy) =>
		policy.text.trim() === '' ? `${nameOf(policy.title)} (no text)` : nameOf(policy.title),
	),
	address_regions: named(
		'country with regions',
		'countries with regions',
		(/** @type {import('./address.js').AddressRegions} */ entry) => `${nameOf(entry.country)} (${entry.names.length})`,
	),
	delivery_zones: named('zone', 'zones', (/** @type {Zone} */ zone) => nameOf(zone.name)),
	tax_rules: named('tax rule', 'tax rules', (/** @type {TaxRule} */ rule) => `${nameOf(rule.name)} ${rule.percent}%`),
	grades: gradeWords,
	unit_states: named('unit state', 'unit states', (/** @type {{ label: string }} */ state) => nameOf(state.label)),
	item_types: typeWords,
	booking_hours: hoursWords,
	role_prices: named(
		'role price',
		'role prices',
		(/** @type {RolePrice} */ price) => `${nameOf(price.role)} ${price.percent}% off`,
	),
});

/**
 * What the summaries read: each feature's settings while it is on (null while off); `seo`: the `seo` settings the
 * pages follow while Catalog is on (the defaults while SEO is off).
 * @typedef {{ on: string[], catalog: Record<string, any> | null, seo: Record<string, any> | null,
 *   landing: Record<string, any> | null, alerts: Record<string, any> | null, llms: Record<string, any> | null }} SetupFacts
 */

/** @param {unknown} value */
const given = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The pages the website makes for the shop, at their addresses.
 * @param {SetupFacts & { catalog: Record<string, any> }} facts
 */
const pagesText = ({ on, catalog, landing, alerts }) => {
	const pages = [`product pages at ${catalog.productUrl}`, `category pages at ${catalog.categoryUrl}`];
	if (on.includes('variants') && given(catalog.variantQuery))
		pages.push(`variants at their product's address with ?${catalog.variantQuery}`);
	if (landing) {
		pages.push(`landing pages at ${landing.landingUrl}`);
		if (given(landing.attributeUrl)) pages.push(`attribute glossary pages at ${landing.attributeUrl}`);
		if (given(landing.gradeUrl)) pages.push(`grade glossary pages at ${landing.gradeUrl}`);
	}
	if (on.includes('checkout')) pages.push('a cart page and an orders page (the cart and my_orders widgets)');
	if (on.includes('wishlist')) pages.push('a wishlist page');
	if (on.includes('compare')) pages.push('a compare page');
	if (alerts) pages.push(`the alert stop page at ${stopPage(alerts.stopUrl)}`);
	const [head = '', ...rest] = pages;
	return `${head.charAt(0).toUpperCase()}${head.slice(1)}${rest.length > 0 ? `, ${rest.join(', ')}` : ''}.`;
};

/**
 * What the website serves from its own domain, fetched by its server with the server token: the media route while
 * there is no public media address, the sitemap, feeds and llms.txt of the features on, and the policy pages.
 * @param {SetupFacts & { catalog: Record<string, any> }} facts
 * @returns {string | null}
 */
const servedText = ({ on, catalog, seo, llms }) => {
	const served = SITE_ROUTES.filter(
		(entry) =>
			on.includes(entry.feature) &&
			(entry.name !== 'media' || !given(catalog.mediaBaseUrl)) &&
			(entry.name !== 'llmsFull' || llms?.full === true),
	).map((entry) => {
		const path =
			entry.name === 'sitemap'
				? String(seo?.sitemapUrl)
				: entry.name === 'media'
					? `${catalog.mediaPath}/<signature>/<file>`
					: entry.file.replace(/^app/, '').replace(/\/route\.js$/, '');
		return `${path} (GET ${entry.route})`;
	});
	if (on.includes('checkout')) served.push('your policy pages (GET /v1/policies)');
	if (served.length === 0) return null;
	return `Your server fetches these with the server token, never from the browser, and serves them from your domain: ${served.join(', ')}.`;
};

/**
 * Ecommerce's summaries on the Setup sheet while Catalog is on: the pages and their addresses, what the website
 * serves from its own domain and the tags of its page heads (baseline SEO comes with the catalog).
 * @param {SetupFacts} facts
 * @returns {Array<{ title: string, text: string }>}
 */
export const setupSummaries = (facts) => {
	const { catalog, seo } = facts;
	if (!catalog || !seo) return [];
	const served = servedText({ ...facts, catalog });
	return [
		{ title: 'Pages on your website', text: pagesText({ ...facts, catalog }) },
		...(served ? [{ title: 'Served from your domain', text: served }] : []),
		{
			title: 'SEO tags',
			text: `Each product, category and listing page puts its SEO answer in its head: the title, meta description, canonical link, robots and the JSON-LD script (GET /v1/seo/products/<slug>, /v1/seo/categories/<slug> and /v1/seo/listing), and the home page the business and website data (GET /v1/seo/site); an answer { moved } is a 308 to its url. Page titles follow ${seo.titleTemplate}.`,
		},
	];
};
