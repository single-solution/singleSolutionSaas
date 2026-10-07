/**
 * Items (pure). A wishlist holds any kind of item: the merchant's external id (plus an optional variant id) and a
 * snapshot of what the shopper saw — title, image, price and URL. Nothing about the item is assumed (no catalogue
 * lookups, no categories, no currency): the snapshot is validated, capped and kept as given, and links are accepted
 * only under the website's URL policy.
 * @module
 */

/** External ids: the merchant's own (SKU, slug, database id, URN…), no spaces and no `#`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Control characters (C0, DEL, C1) and bidi/zero-width formatting characters are stripped from snapshot text. */
// eslint-disable-next-line no-control-regex -- the point of the pattern
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Longest snapshot title and URL. */
export const LIMITS = Object.freeze({ title: 200, url: 2048, amount: 10_000_000_000_000 });

/**
 * @typedef {{ amount: number, currency: string }} Money integer minor units + ISO 4217 code
 * @typedef {object} Item
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} title
 * @property {string | null} image
 * @property {string | null} url
 * @property {Money | null} price
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {value is string} */
export const isRef = (value) => typeof value === 'string' && ID.test(value);

/**
 * The key of an item within a list (`#` never appears in ids).
 * @param {{ itemId: string, variantId?: string | null }} item
 */
export const itemKeyOf = ({ itemId, variantId }) => (variantId ? `${itemId}#${variantId}` : itemId);

/**
 * Snapshot text: unsafe characters removed, whitespace collapsed, capped. Null when empty.
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
export const cleanText = (value, max) => {
	if (typeof value !== 'string') return null;
	const text = value.replace(UNSAFE_TEXT, '').replace(/\s+/g, ' ').trim();
	return text ? Array.from(text).slice(0, max).join('') : null;
};

/**
 * Money in integer minor units: the value, null when absent, undefined when invalid.
 * @param {unknown} value
 * @returns {Money | null | undefined}
 */
export const moneyOf = (value) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return undefined;
	const { amount, currency } = value;
	if (!Number.isSafeInteger(amount) || amount < 0 || amount > LIMITS.amount) return undefined;
	if (typeof currency !== 'string' || !CURRENCY.test(currency)) return undefined;
	return { amount, currency };
};

/**
 * Whether a host is the website's domain (or a subdomain when allowed).
 * @param {string} host
 * @param {{ domain?: string | null, allowSubdomains?: boolean }} site
 */
const onSite = (host, { domain, allowSubdomains = false }) =>
	typeof domain === 'string' && domain.length > 0 && (host === domain || (allowSubdomains && host.endsWith(`.${domain}`)));

/**
 * A link accepted under a policy (https only, no credentials), else null.
 * @param {unknown} value
 * @param {{ policy: 'same_site' | 'any_https' | 'none', domain?: string | null, allowSubdomains?: boolean }} options
 * @returns {string | null}
 */
export const linkOf = (value, { policy, domain = null, allowSubdomains = false }) => {
	if (policy === 'none' || typeof value !== 'string' || value.length > LIMITS.url) return null;
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null;
	if (policy === 'same_site' && !onSite(url.hostname.toLowerCase(), { domain, allowSubdomains })) return null;
	return url.href;
};

/**
 * @typedef {object} ItemPolicy
 * @property {'same_site' | 'any_https' | 'none'} urlPolicy
 * @property {'same_site' | 'any_https' | 'none'} imagePolicy
 * @property {string | null} domain
 * @property {boolean} allowSubdomains
 */

/**
 * Validate an item from a request: ids are required and strict, the snapshot is cleaned and capped, links follow the
 * website's policy (a refused link is dropped, not an error), an invalid price is an error.
 * @param {unknown} input
 * @param {ItemPolicy} policy
 * @param {string} [path] JSON pointer of the item in the request
 * @returns {{ ok: true, item: Item } | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const parseItem = (input, policy, path = '') => {
	if (!isObject(input)) return { ok: false, errors: [{ path: path || '/', code: 'invalid' }] };
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	if (input.itemId === undefined) errors.push({ path: `${path}/itemId`, code: 'required' });
	else if (!isRef(input.itemId)) errors.push({ path: `${path}/itemId`, code: 'invalid' });
	if (input.variantId !== undefined && input.variantId !== null && !isRef(input.variantId))
		errors.push({ path: `${path}/variantId`, code: 'invalid' });
	const price = moneyOf(input.price);
	if (price === undefined) errors.push({ path: `${path}/price`, code: 'invalid' });
	if (errors.length > 0) return { ok: false, errors };
	const site = { domain: policy.domain, allowSubdomains: policy.allowSubdomains };
	return {
		ok: true,
		item: {
			itemId: /** @type {string} */ (input.itemId),
			variantId: isRef(input.variantId) ? input.variantId : null,
			title: cleanText(input.title, LIMITS.title),
			image: linkOf(input.image, { policy: policy.imagePolicy, ...site }),
			url: linkOf(input.url, { policy: policy.urlPolicy, ...site }),
			price: price ?? null,
		},
	};
};
