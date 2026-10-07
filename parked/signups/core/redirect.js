/**
 * Magic-link redirects (pure). A link may only lead back to **the website itself**: `https:` on the website's domain
 * (or a subdomain when the website allows subdomains), no credentials in the URL, a path under one of the configured
 * prefixes. The one-time token travels in the URL fragment (`#ss_magic=…`), which browsers never send to servers or in
 * `Referer` headers, so it does not land in access logs.
 * @module
 */

/** Fragment parameter carrying the magic-link token. */
export const MAGIC_FRAGMENT = 'ss_magic';

/**
 * @param {string} host lower-case host name
 * @param {string} domain the website's domain
 * @param {boolean} allowSubdomains
 */
export const hostAllowed = (host, domain, allowSubdomains) => host === domain || (allowSubdomains && host.endsWith(`.${domain}`));

/**
 * @param {string} path URL path
 * @param {readonly string[]} prefixes allowed path prefixes (`/` allows everything)
 */
const pathAllowed = (path, prefixes) =>
	prefixes.some((prefix) => {
		if (typeof prefix !== 'string' || !prefix.startsWith('/')) return false;
		if (prefix === '/') return true;
		const base = prefix.replace(/\/+$/, '');
		return path === base || path.startsWith(`${base}/`);
	});

/**
 * Resolve where a magic link leads.
 * @param {{ redirect?: unknown, domain: string, allowSubdomains: boolean, allowedPaths: readonly string[], callbackPath: string }} input
 *   `redirect` absent → `https://<domain><callbackPath>`
 * @returns {{ ok: true, url: string } | { ok: false, code: 'redirect_not_allowed' }}
 */
export const resolveRedirect = ({ redirect, domain, allowSubdomains, allowedPaths, callbackPath }) => {
	const candidate =
		redirect === undefined || redirect === null || redirect === '' ? `https://${domain}${callbackPath}` : redirect;
	if (typeof candidate !== 'string' || candidate.length > 2048 || /[\s\\]/.test(candidate))
		return { ok: false, code: 'redirect_not_allowed' };
	/** @type {URL} */
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false, code: 'redirect_not_allowed' };
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port !== '')
		return { ok: false, code: 'redirect_not_allowed' };
	if (!hostAllowed(url.hostname.toLowerCase(), domain.toLowerCase(), allowSubdomains))
		return { ok: false, code: 'redirect_not_allowed' };
	if (!pathAllowed(url.pathname, allowedPaths)) return { ok: false, code: 'redirect_not_allowed' };
	url.hash = '';
	return { ok: true, url: url.href };
};

/**
 * The link sent to the customer.
 * @param {string} url an allowed redirect (no fragment)
 * @param {string} token
 */
export const magicLink = (url, token) => `${url}#${MAGIC_FRAGMENT}=${encodeURIComponent(token)}`;
