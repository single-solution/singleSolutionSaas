/**
 * Share and auto-apply links (pure). A share link is the website's own page with the code in a query parameter
 * (`codes.auto_apply_param`, default `coupon`): `https://shop.example.com/?coupon=FALL-K7QM`. The apply box (Mode A/B)
 * reads the same parameter and applies the code automatically. Campaign parameters are optional configuration.
 * @module
 */

const PARAM = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * @param {{ domain: string, path: string, param: string, code: string, utm?: { source?: string, medium?: string, campaign?: string } }} input
 * @returns {string | null} null when the domain, path or parameter is unusable
 */
export const shareLink = ({ domain, path, param, code, utm = {} }) => {
	if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) return null;
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
	if (!PARAM.test(param)) return null;
	let url;
	try {
		url = new URL(path, `https://${domain}`);
	} catch {
		return null;
	}
	if (url.host.toLowerCase() !== domain.toLowerCase()) return null;
	url.searchParams.set(param, code);
	for (const [key, value] of Object.entries(utm))
		if (typeof value === 'string' && value.length > 0) url.searchParams.set(`utm_${key}`, value);
	return url.toString();
};

/**
 * The code carried by a URL (auto-apply), or null.
 * @param {unknown} href absolute URL or a query string (`?coupon=…`)
 * @param {string} param
 * @returns {string | null}
 */
export const codeFromUrl = (href, param) => {
	if (typeof href !== 'string' || href.length === 0 || href.length > 4096 || !PARAM.test(param)) return null;
	let search;
	try {
		search = href.startsWith('?') ? new URLSearchParams(href) : new URL(href).searchParams;
	} catch {
		return null;
	}
	const value = search.get(param);
	return value && value.trim().length > 0 ? value.trim() : null;
};
