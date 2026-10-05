/**
 * Page-level rules: hosted-page route patterns, related-item selection, share links, sticky-bar visibility and the
 * presence of another product's element. Pure functions of their inputs.
 * @module
 */
import { isObject, text } from './util.js';

// ---- routes ---------------------------------------------------------------------------------------------------

/**
 * Match a route pattern against a path. Patterns are literal segments, `{name}` parameters (one segment) and `*`
 * (any one segment): `/products/{slug}`, `/{category}/{id}`. Returns the decoded parameters, or null.
 * @param {string} pattern
 * @param {string} path
 * @returns {Record<string, string> | null}
 */
export const matchRoute = (pattern, path) => {
	if (!pattern.startsWith('/') || pattern.length > 200 || path.length > 2048) return null;
	const want = pattern.replace(/\/+$/, '').split('/');
	const have = path.split(/[?#]/)[0]?.replace(/\/+$/, '').split('/') ?? [];
	if (want.length !== have.length) return null;
	/** @type {Record<string, string>} */
	const params = {};
	for (const [index, segment] of want.entries()) {
		const actual = have[index] ?? '';
		const name = /^\{([A-Za-z_]\w*)\}$/.exec(segment)?.[1];
		if (name !== undefined || segment === '*') {
			if (actual === '') return null;
			if (name !== undefined) {
				try {
					params[name] = decodeURIComponent(actual);
				} catch {
					return null;
				}
			}
		} else if (segment !== actual) return null;
	}
	return params;
};

// ---- related items ----------------------------------------------------------------------------------------------

/** Related-item strategies a pack can apply without a catalog: the given list, or that list narrowed. */
export const RELATED_STRATEGIES = Object.freeze(/** @type {const} */ (['provided', 'same_brand', 'same_category']));

/**
 * Related items to show: never the item itself, narrowed by the strategy, at most `count`.
 * @param {import('./item.js').Item} item
 * @param {readonly import('./item.js').RelatedItem[]} candidates
 * @param {{ strategy: (typeof RELATED_STRATEGIES)[number], count: number }} options
 * @returns {import('./item.js').RelatedItem[]}
 */
export const selectRelated = (item, candidates, { strategy, count }) => {
	const same = (/** @type {string} */ a, /** @type {string} */ b) => a !== '' && a.toLowerCase() === b.toLowerCase();
	return candidates
		.filter((entry) => !(item.id !== '' && entry.id === item.id) && !(item.url !== '' && entry.url === item.url))
		.filter((entry) =>
			strategy === 'same_brand'
				? same(entry.brand, item.brand)
				: strategy === 'same_category'
					? same(entry.category, item.category)
					: true,
		)
		.slice(0, count);
};

// ---- share ------------------------------------------------------------------------------------------------------

/** Share channels. `native` uses the device share sheet, `copy` the clipboard; the others open the network's page. */
export const SHARE_CHANNELS = Object.freeze(
	/** @type {const} */ (['native', 'copy', 'whatsapp', 'facebook', 'x', 'telegram', 'linkedin', 'pinterest', 'email']),
);

/** Public share endpoints of the networks (`{url}`, `{text}`, `{image}` are URL-encoded). */
const SHARE_URLS = Object.freeze(
	/** @type {Record<string, string>} */ ({
		whatsapp: 'https://wa.me/?text={text}%20{url}',
		facebook: 'https://www.facebook.com/sharer/sharer.php?u={url}',
		x: 'https://x.com/intent/post?url={url}&text={text}',
		telegram: 'https://t.me/share/url?url={url}&text={text}',
		linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url={url}',
		pinterest: 'https://www.pinterest.com/pin/create/button/?url={url}&media={image}&description={text}',
		email: 'mailto:?subject={text}&body={url}',
	}),
);

/**
 * The shared URL, with `utm_source=<channel>&utm_medium=share` when asked (absolute http(s) URLs only).
 * @param {string} url
 * @param {string} channel
 * @param {boolean} utm
 * @returns {string}
 */
export const shareTarget = (url, channel, utm) => {
	if (!utm) return url;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url;
		parsed.searchParams.set('utm_source', channel);
		parsed.searchParams.set('utm_medium', 'share');
		return parsed.href;
	} catch {
		return url;
	}
};

/**
 * Link of a network share channel ('' for `native`, `copy` and unknown channels).
 * @param {string} channel
 * @param {{ url: string, text: string, image: string }} input
 * @returns {string}
 */
export const shareHref = (channel, { url, text: title, image }) => {
	const template = SHARE_URLS[channel];
	if (template === undefined) return '';
	/** @type {Record<string, string>} */
	const values = { url, text: text(title, 300), image };
	return template.replace(/\{(url|text|image)\}/g, (_match, name) => encodeURIComponent(values[name] ?? ''));
};

// ---- sticky buy bar ------------------------------------------------------------------------------------------

export const DEVICES = Object.freeze(/** @type {const} */ (['mobile', 'tablet', 'desktop']));
export const STICKY_MODES = Object.freeze(/** @type {const} */ (['after_cta', 'after_scroll', 'always']));

/**
 * Device class of a viewport width (the Loader's breakpoints: < 768 mobile, < 1024 tablet).
 * @param {number} width
 * @returns {(typeof DEVICES)[number]}
 */
export const deviceOf = (width) => (width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop');

/**
 * Whether the sticky bar shows.
 * @param {{ devices: readonly string[], mode: (typeof STICKY_MODES)[number], scrollPercent: number, hideUnavailable: boolean }} rules
 * @param {{ device: string, ctaVisible: boolean, scrolled: number, available: boolean, dismissed: boolean }} view
 * @returns {boolean}
 */
export const stickyVisible = (rules, view) => {
	if (view.dismissed || !rules.devices.includes(view.device)) return false;
	if (rules.hideUnavailable && !view.available) return false;
	if (rules.mode === 'always') return true;
	if (rules.mode === 'after_scroll') return view.scrolled >= rules.scrollPercent;
	return !view.ctaVisible;
};

// ---- other products' elements ----------------------------------------------------------------------------------

/**
 * Status of another product's element in the Loader's element list (`SS.elements.list()`): `absent` when it is not
 * on this website (not subscribed, switched off or failed), `active` when mounted, `waiting` while it is pending.
 * @param {unknown} list
 * @param {string} key
 * @param {string} [product] the delivering product (entries of another product with the same key do not count)
 * @returns {'absent' | 'waiting' | 'active'}
 */
export const elementStatus = (list, key, product) => {
	const entry = (Array.isArray(list) ? list : []).find(
		(candidate) =>
			isObject(candidate) &&
			candidate.key === key &&
			(product === undefined || candidate.product === undefined || candidate.product === product),
	);
	if (!entry || entry.status === 'failed') return 'absent';
	return entry.status === 'mounted' ? 'active' : 'waiting';
};
