/**
 * Growth's merchant lists (the kit's list settings, `GET|PUT /v1/lists/:list` and the dashboard's Settings): records a
 * settings schema cannot hold. Each list names its feature (any of them), its title, the most entries it keeps, its
 * fields and its defaults (today's behavior, so a website that never saved it works as before). Pure: one check for the
 * server, the dashboard's editor and the docs.
 *
 * - `goals` and `funnels` (Goals and funnels, G1, G2): what the merchant counts. A goal or a funnel step is an event
 *   (a shop event, `contact`, or a custom event the page sends with `SSGrowth.track(name, props)`) or a page (a path
 *   pattern: an exact path, `*` one segment, `**` any). The shop funnel is seeded.
 * - `consent_categories` (G3): the consent banner's categories, each `required`, `opt_in` (off until the visitor agrees)
 *   or `opt_out` (on until the visitor says no, such as the US "sale or sharing" of personal data), with the Google
 *   Consent Mode v2 signals it grants and the scripts it loads. Seeded: necessary, preferences, analytics, marketing and
 *   sale or sharing.
 * - `announcements` (G4): the notice bar's announcements, each with its schedule (times on the business time zone's
 *   clock), its pages and how long a closed one stays closed.
 * - `conversion_actions` (G5): which event goes to Meta, Google and TikTok under which name, and as which Google Ads
 *   conversion. Seeded with the shop events, search and contact.
 * - `verification_tags` (G8): more verification meta tags `{ name, content }` (the four known ones are settings).
 * - `seo_ignored` (G9): SEO checklist findings the merchant ignores, per check and page pattern.
 * @module
 */
import { CONSENT_SIGNALS } from './widgets.js';

/** @typedef {{ path: string, message: string }} ListError */
/** @typedef {{ ok: true, value: any[] } | { ok: false, errors: ListError[] }} ListCheck */

/**
 * A field of a list entry:
 * - `text`: trimmed text (`max` characters, optional `pattern`, `required`, `lower` case);
 * - `choice`: one of `choices`; `choices`: several of them (no repeats);
 * - `flag`: true or false; `number`: a whole number from `min` to `max`;
 * - `paths`: path patterns (from `/`, `*` and `**` segments), at most `max`;
 * - `time`: a wall-clock time `YYYY-MM-DDTHH:mm` on the business time zone's clock, or '' for none;
 * - `rows`: entries of their own `fields`, from `min` to `max`.
 * @typedef {{ type: 'text', max: number, pattern?: RegExp, required?: boolean, lower?: boolean, default?: string }
 *   | { type: 'choice', choices: readonly string[], default: string }
 *   | { type: 'choices', choices: readonly string[], default?: string[] }
 *   | { type: 'flag', default: boolean }
 *   | { type: 'number', min: number, max: number, default: number }
 *   | { type: 'paths', max: number, default?: string[] }
 *   | { type: 'time' }
 *   | { type: 'rows', min: number, max: number, fields: Record<string, Field> }} Field
 */

/**
 * @typedef {object} ListSpec
 * @property {string | string[]} feature the feature it belongs to (any of them)
 * @property {string} title its name on screens
 * @property {number} max most entries
 * @property {Record<string, Field>} fields
 * @property {string} [unique] a field no two entries share
 * @property {(entry: Record<string, any>) => Array<[string, string]>} [rules] more rules of one entry: `[field, message]`
 * @property {() => any[]} defaults its value before it is saved
 */

/** A key: lower-case letters, digits and `_`, from a letter, at most 40. */
export const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** An event name: a key (`purchase`, `book_demo`). */
export const EVENT_NAME = KEY;

/** A pixel's event name: letters, digits, `_` and `-`, at most 60 (Meta `Purchase`, GA4 `add_to_cart`). */
const PIXEL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;

/** A path pattern: from `/`, no query, fragment or spaces; segments `*` and `**` are wildcards. */
const PATH_PATTERN = /^\/[^\s?#]*$/;

/** A wall-clock time on the business time zone's clock. */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** What a goal or funnel step matches: an event, or a page (a path pattern). */
export const MATCH_KINDS = Object.freeze(/** @type {const} */ (['event', 'page']));

/** How a consent category asks: always on, off until agreed, or on until refused. */
export const CONSENT_MODES = Object.freeze(/** @type {const} */ (['required', 'opt_in', 'opt_out']));

/** How long a closed announcement stays closed: until another page, the rest of the visit, or some days. */
export const DISMISS_KINDS = Object.freeze(/** @type {const} */ (['page', 'visit', 'days']));

/**
 * Meta tags a verification tag may never be: they change how the page is indexed or shown.
 */
const RESERVED_META = Object.freeze([
	'robots',
	'googlebot',
	'googlebot-news',
	'bingbot',
	'viewport',
	'description',
	'keywords',
	'referrer',
	'theme-color',
	'color-scheme',
	'author',
	'generator',
	'application-name',
	'format-detection',
	'ss-growth-page',
]);

/** @param {string} kind @param {string} match */
const matchRules = (kind, match) => {
	if (kind === 'event' && !EVENT_NAME.test(match))
		return 'An event is a name of lower-case letters, digits and _ from a letter (for example purchase or book_demo).';
	if (kind === 'page' && !PATH_PATTERN.test(match))
		return 'A page is a path from / (* is one segment, ** any; for example /thank-you or /blog/**).';
	return null;
};

/** The steps of a funnel. @type {Record<string, Field>} */
const STEP_FIELDS = {
	name: { type: 'text', max: 60, required: true },
	kind: { type: 'choice', choices: MATCH_KINDS, default: 'event' },
	match: { type: 'text', max: 200, required: true },
};

/** The shop funnel every website starts with (G1): GA4's and Plausible's view → cart → checkout → purchase. */
export const SHOP_FUNNEL = Object.freeze({
	key: 'shop',
	name: 'Shop',
	steps: [
		{ name: 'Viewed an item', kind: 'event', match: 'view_item' },
		{ name: 'Added to cart', kind: 'event', match: 'add_to_cart' },
		{ name: 'Began checkout', kind: 'event', match: 'begin_checkout' },
		{ name: 'Purchased', kind: 'event', match: 'purchase' },
	],
});

/** The goals every website starts with: a purchase and a contact (G2). */
const DEFAULT_GOALS = Object.freeze([
	{ key: 'purchase', name: 'Purchase', kind: 'event', match: 'purchase' },
	{ key: 'contact', name: 'Contact', kind: 'event', match: 'contact' },
]);

/** The consent categories every website starts with (G3). */
export const DEFAULT_CATEGORIES = Object.freeze([
	{
		key: 'necessary',
		name: 'Necessary',
		description: 'Needed for the site to work, such as your cart and sign-in. Always on.',
		mode: 'required',
		signals: ['security_storage'],
		scripts: '',
	},
	{
		key: 'preferences',
		name: 'Preferences',
		description: 'Remember your choices, such as language and region.',
		mode: 'opt_in',
		signals: ['functionality_storage', 'personalization_storage'],
		scripts: '',
	},
	{
		key: 'analytics',
		name: 'Analytics',
		description: 'Count visits and see how the site is used, so we can improve it.',
		mode: 'opt_in',
		signals: ['analytics_storage'],
		scripts: '',
	},
	{
		key: 'marketing',
		name: 'Marketing',
		description: 'Measure ads and show you relevant offers on other sites.',
		mode: 'opt_in',
		signals: ['ad_storage', 'ad_user_data', 'ad_personalization'],
		scripts: '',
	},
	{
		key: 'sale_sharing',
		name: 'Sale or sharing of personal data',
		description: 'Share data with advertising partners. Turn this off to opt out of the sale or sharing of your personal data.',
		mode: 'opt_out',
		signals: ['ad_user_data', 'ad_personalization'],
		scripts: '',
	},
]);

/** The conversion actions every website starts with (G5): the shop events, search and contact, as each pixel names them. */
export const DEFAULT_ACTIONS = Object.freeze([
	{ event: 'view_item', meta: 'ViewContent', google: 'view_item', tiktok: 'ViewContent', adsLabel: '' },
	{ event: 'add_to_cart', meta: 'AddToCart', google: 'add_to_cart', tiktok: 'AddToCart', adsLabel: '' },
	{ event: 'begin_checkout', meta: 'InitiateCheckout', google: 'begin_checkout', tiktok: 'InitiateCheckout', adsLabel: '' },
	{ event: 'purchase', meta: 'Purchase', google: 'purchase', tiktok: 'CompletePayment', adsLabel: '' },
	{ event: 'search', meta: 'Search', google: 'search', tiktok: 'Search', adsLabel: '' },
	{ event: 'contact', meta: 'Contact', google: 'generate_lead', tiktok: 'Contact', adsLabel: '' },
]);

/** Every list Growth keeps. */
const SPECS = /** @satisfies {Record<string, ListSpec>} */ ({
	goals: {
		feature: 'conversion_funnel',
		title: 'Goals',
		max: 30,
		unique: 'key',
		fields: {
			key: { type: 'text', max: 40, pattern: KEY, required: true, lower: true },
			name: { type: 'text', max: 60, required: true },
			kind: { type: 'choice', choices: MATCH_KINDS, default: 'event' },
			match: { type: 'text', max: 200, required: true },
		},
		rules: (entry) => {
			const problem = matchRules(entry.kind, entry.match);
			return problem ? [['match', problem]] : [];
		},
		defaults: () => DEFAULT_GOALS.map((goal) => ({ ...goal })),
	},
	funnels: {
		feature: 'conversion_funnel',
		title: 'Funnels',
		max: 10,
		unique: 'key',
		fields: {
			key: { type: 'text', max: 40, pattern: KEY, required: true, lower: true },
			name: { type: 'text', max: 60, required: true },
			steps: { type: 'rows', min: 2, max: 8, fields: STEP_FIELDS },
		},
		rules: (entry) =>
			entry.steps.flatMap((/** @type {any} */ step, /** @type {number} */ at) => {
				const problem = matchRules(step.kind, step.match);
				return problem ? [[`steps/${at}/match`, problem]] : [];
			}),
		defaults: () => [structuredClone(SHOP_FUNNEL)],
	},
	consent_categories: {
		feature: ['consent_banner', 'meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'],
		title: 'Consent categories',
		max: 10,
		unique: 'key',
		fields: {
			key: { type: 'text', max: 40, pattern: KEY, required: true, lower: true },
			name: { type: 'text', max: 60, required: true },
			description: { type: 'text', max: 300 },
			mode: { type: 'choice', choices: CONSENT_MODES, default: 'opt_in' },
			signals: { type: 'choices', choices: CONSENT_SIGNALS },
			scripts: { type: 'text', max: 20_000 },
		},
		rules: (entry) => (entry.key === 'at' ? [['key', 'at is kept for the time of the choice; pick another key.']] : []),
		defaults: () => DEFAULT_CATEGORIES.map((category) => structuredClone(category)),
	},
	announcements: {
		feature: 'notice_bar',
		title: 'Announcements',
		max: 20,
		unique: 'key',
		fields: {
			key: { type: 'text', max: 40, pattern: KEY, required: true, lower: true },
			text: { type: 'text', max: 300, required: true },
			linkText: { type: 'text', max: 60 },
			linkUrl: { type: 'text', max: 2048 },
			startsAt: { type: 'time' },
			endsAt: { type: 'time' },
			pages: { type: 'paths', max: 50 },
			hideOnPages: { type: 'paths', max: 50 },
			dismissible: { type: 'flag', default: true },
			dismiss: { type: 'choice', choices: DISMISS_KINDS, default: 'visit' },
			dismissDays: { type: 'number', min: 1, max: 365, default: 7 },
		},
		rules: (entry) => [
			...(entry.linkUrl !== '' && !isLink(entry.linkUrl)
				? /** @type {Array<[string, string]>} */ ([['linkUrl', 'The link is an https address or a path on your website.']])
				: []),
			...(entry.startsAt !== '' && entry.endsAt !== '' && entry.endsAt <= entry.startsAt
				? /** @type {Array<[string, string]>} */ ([['endsAt', 'The end comes after the start.']])
				: []),
		],
		defaults: () => [],
	},
	conversion_actions: {
		feature: ['meta_pixel', 'google_tags', 'tiktok_pixel'],
		title: 'Conversion actions',
		max: 30,
		unique: 'event',
		fields: {
			event: { type: 'text', max: 40, pattern: EVENT_NAME, required: true },
			meta: { type: 'text', max: 60, pattern: PIXEL_NAME },
			google: { type: 'text', max: 60, pattern: PIXEL_NAME },
			tiktok: { type: 'text', max: 60, pattern: PIXEL_NAME },
			adsLabel: { type: 'text', max: 40, pattern: /^[A-Za-z0-9_-]{4,40}$/ },
		},
		defaults: () => DEFAULT_ACTIONS.map((action) => ({ ...action })),
	},
	verification_tags: {
		feature: 'robots_verification',
		title: 'More verification tags',
		max: 20,
		unique: 'name',
		fields: {
			name: { type: 'text', max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, required: true },
			content: { type: 'text', max: 300, required: true },
		},
		rules: (entry) => [
			...(RESERVED_META.includes(entry.name.toLowerCase())
				? /** @type {Array<[string, string]>} */ ([
						['name', `${entry.name} changes how the page is shown or indexed: not a verification tag.`],
					])
				: []),
			...(verificationContentOf(entry.content) === null
				? /** @type {Array<[string, string]>} */ ([
						['content', 'The content is letters, digits and . _ = : / + - (or paste the whole meta tag).'],
					])
				: []),
		],
		defaults: () => [],
	},
	seo_ignored: {
		feature: 'seo_checklist',
		title: 'Ignored SEO findings',
		max: 200,
		fields: {
			check: { type: 'text', max: 40, pattern: KEY, required: true },
			page: { type: 'text', max: 300 },
		},
		rules: (entry) =>
			entry.page !== '' && !PATH_PATTERN.test(entry.page)
				? [['page', 'The page is a path from / (* is one segment, ** any), or empty for every page.']]
				: [],
		defaults: () => [],
	},
});

/** @typedef {keyof typeof SPECS} ListName */

/** Every list Growth keeps, by name. */
export const LISTS = /** @type {Readonly<Record<ListName, ListSpec>>} */ (Object.freeze(SPECS));

/**
 * A link a widget may show: a path on the website or an https address.
 * @param {string} value
 */
const isLink = (value) => {
	if (value.startsWith('/') && !value.startsWith('//') && !/\s/.test(value)) return true;
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
};

/**
 * A verification tag's content: the text itself, or the `content` of a pasted meta tag, when it is a token; else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const verificationContentOf = (value) => {
	if (typeof value !== 'string') return null;
	const pasted = /content\s*=\s*["']([^"']*)["']/i.exec(value)?.[1] ?? value;
	const token = pasted.trim();
	return /^[A-Za-z0-9_.=:/+-]{1,200}$/.test(token) ? token : null;
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One field's value, checked: the value, or the problem.
 * @param {Field} field
 * @param {unknown} raw
 * @param {string} at the field's path
 * @param {ListError[]} errors
 * @returns {unknown}
 */
const fieldValue = (field, raw, at, errors) => {
	/** @param {string} message */
	const fail = (message) => {
		errors.push({ path: at, message });
		return undefined;
	};
	switch (field.type) {
		case 'text': {
			if (raw !== undefined && raw !== null && typeof raw !== 'string') return fail('is a text.');
			let text = typeof raw === 'string' ? raw.trim() : (field.default ?? '');
			if (field.lower) text = text.toLowerCase();
			if (text === '') return field.required ? fail('is required.') : '';
			if ([...text].length > field.max) return fail(`is at most ${field.max} characters.`);
			if (field.pattern && !field.pattern.test(text)) return fail('is not in the right form.');
			return text;
		}
		case 'choice':
			if (raw === undefined || raw === null || raw === '') return field.default;
			return field.choices.includes(/** @type {string} */ (raw)) ? raw : fail(`is one of ${field.choices.join(', ')}.`);
		case 'choices': {
			if (raw === undefined || raw === null) return [...(field.default ?? [])];
			if (!Array.isArray(raw) || raw.some((value) => !field.choices.includes(value)))
				return fail(`lists some of ${field.choices.join(', ')}.`);
			return [...new Set(raw)];
		}
		case 'flag':
			if (raw === undefined || raw === null) return field.default;
			return typeof raw === 'boolean' ? raw : fail('is true or false.');
		case 'number':
			if (raw === undefined || raw === null) return field.default;
			return Number.isSafeInteger(raw) && Number(raw) >= field.min && Number(raw) <= field.max
				? raw
				: fail(`is a whole number from ${field.min} to ${field.max}.`);
		case 'paths': {
			if (raw === undefined || raw === null) return [...(field.default ?? [])];
			if (!Array.isArray(raw)) return fail('is a list of paths.');
			const paths = [...new Set(raw.map((value) => (typeof value === 'string' ? value.trim() : value)))].filter(
				(value) => value !== '',
			);
			if (paths.some((value) => typeof value !== 'string' || value.length > 200 || !PATH_PATTERN.test(value)))
				return fail('lists paths from / (* is one segment, ** any).');
			if (paths.length > field.max) return fail(`lists at most ${field.max} paths.`);
			return paths;
		}
		case 'time': {
			if (raw === undefined || raw === null || raw === '') return '';
			if (
				typeof raw !== 'string' ||
				!LOCAL_TIME.test(raw) ||
				new Date(Date.parse(`${raw}:00Z`) || 0).toISOString().slice(0, 16) !== raw
			)
				return fail('is a time YYYY-MM-DDTHH:mm on your business time zone’s clock, or empty.');
			return raw;
		}
		case 'rows': {
			if (!Array.isArray(raw)) return fail(`is a list of ${field.min} to ${field.max} entries.`);
			if (raw.length < field.min || raw.length > field.max) return fail(`has ${field.min} to ${field.max} entries.`);
			return raw.map((row, index) => entryOf(field.fields, row, `${at}/${index}`, errors));
		}
		default:
			return fail('is not known.');
	}
};

/**
 * One entry, checked field by field (unknown members refused).
 * @param {Record<string, Field>} fields
 * @param {unknown} raw
 * @param {string} at
 * @param {ListError[]} errors
 * @returns {Record<string, unknown>}
 */
const entryOf = (fields, raw, at, errors) => {
	if (!isObject(raw)) {
		errors.push({ path: at, message: 'is an object.' });
		return {};
	}
	for (const name of Object.keys(raw))
		if (!Object.hasOwn(fields, name)) errors.push({ path: `${at}/${name}`, message: 'is not a member of this list.' });
	return Object.fromEntries(
		Object.entries(fields).map(([name, field]) => [name, fieldValue(field, raw[name], `${at}/${name}`, errors)]),
	);
};

/**
 * A list as sent, checked: every entry's fields (defaults filled in), the list's own rules, no two entries sharing its
 * unique field, at most its `max` entries. Errors name the field (`/value/<index>/<field>`).
 * @param {ListName} name
 * @param {unknown} value
 * @returns {ListCheck}
 */
export const checkList = (name, value) => {
	const spec = LISTS[name];
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '/value', message: `${spec.title} is a list.` }] };
	if (value.length > spec.max)
		return { ok: false, errors: [{ path: '/value', message: `${spec.title} has at most ${spec.max} entries.` }] };
	/** @type {ListError[]} */
	const errors = [];
	const entries = value.map((raw, index) => {
		const before = errors.length;
		const entry = entryOf(spec.fields, raw, `/value/${index}`, errors);
		if (errors.length === before && spec.rules)
			for (const [field, message] of spec.rules(entry)) errors.push({ path: `/value/${index}/${field}`, message });
		return entry;
	});
	if (spec.unique) {
		const unique = spec.unique;
		const seen = new Set();
		entries.forEach((entry, index) => {
			const key = String(entry[unique] ?? '').toLowerCase();
			if (key !== '' && seen.has(key))
				errors.push({ path: `/value/${index}/${unique}`, message: `Another entry has this ${unique}.` });
			seen.add(key);
		});
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: entries };
};

/**
 * A saved list as the code reads it: checked again, so an entry that no longer passes is left out (never a crash).
 * @param {ListName} name
 * @param {unknown} value the saved value, or undefined when it was never saved (its defaults)
 * @returns {any[]}
 */
export const readList = (name, value) => {
	if (value === undefined || value === null) return LISTS[name].defaults();
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const checked = checkList(name, [entry]);
		return checked.ok ? checked.value : [];
	});
};

/**
 * The instant a wall-clock time `YYYY-MM-DDTHH:mm` happens in a time zone (epoch ms), NaN when it is not one. Two
 * passes settle the zone's offset around a daylight-saving change.
 * @param {string} local
 * @param {(at: number) => { year: number, month: number, day: number, hour: number, minute: number, second: number }} partsOf
 *   the wall clock of an instant in the zone
 */
export const zonedTimeOf = (local, partsOf) => {
	const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
	if (!found) return Number.NaN;
	const wall = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]), Number(found[4]), Number(found[5]));
	if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 16) !== local) return Number.NaN;
	/** @param {number} instant */
	const offset = (instant) => {
		const p = partsOf(instant);
		return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
	};
	return wall - offset(wall - offset(wall));
};
