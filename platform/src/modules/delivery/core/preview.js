/**
 * Preview proxy rules (pure; PLAN §4.4): signed short-lived session tokens, the target URL (only the website's own
 * origin), HTML injection (candidate bundle, visible ribbon, `<base>` to the origin) and the response policy
 * (sandboxed, strict CSP, never indexed or cached).
 *
 * On the Portal origin the page is **sandboxed** (`Content-Security-Policy: sandbox`): it runs in an opaque origin
 * and can never use Portal cookies or same-origin APIs. Only the injected, nonce-bearing script runs (`script-src
 * 'nonce-…' 'strict-dynamic'`, which also admits the modules it imports); the merchant's own scripts do not execute.
 *
 * On a **dedicated preview origin** (`PREVIEW_ORIGIN`, F.16 — a cookie-less host that serves nothing but `/p/*`) the
 * sandbox stays but gains `allow-same-origin` and the script policy admits the merchant's own scripts (https and
 * inline), so previews behave like the real site; that origin holds no session and shares nothing with the consoles.
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Preview sessions live 10 minutes. */
export const PREVIEW_TTL_MS = 10 * 60_000;
/** Largest page the proxy fetches. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const TOKEN = /^([A-Za-z0-9_-]{8,400})\.([A-Za-z0-9_-]{43})$/;
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * @typedef {object} PreviewClaims
 * @property {string} previewId
 * @property {string} merchantId
 * @property {string} websiteId
 * @property {number} exp epoch ms
 */

/** @param {Buffer} key @param {string} payload */
const mac = (key, payload) => createHmac('sha256', key).update(`ss-preview.v1.${payload}`).digest('base64url');

/**
 * @param {Buffer} key
 * @param {PreviewClaims} claims
 */
export const signPreviewToken = (key, { previewId, merchantId, websiteId, exp }) => {
	const payload = Buffer.from(JSON.stringify({ p: previewId, m: merchantId, w: websiteId, e: exp })).toString('base64url');
	return `${payload}.${mac(key, payload)}`;
};

/**
 * Verify signature and expiry (no I/O).
 * @param {Buffer} key
 * @param {unknown} token
 * @param {number} now
 * @returns {PreviewClaims | null}
 */
export const verifyPreviewToken = (key, token, now) => {
	const match = typeof token === 'string' ? TOKEN.exec(token) : null;
	if (!match) return null;
	const [, payload, sig] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (match));
	const expected = Buffer.from(mac(key, payload));
	const given = Buffer.from(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		if (typeof claims.p !== 'string' || typeof claims.m !== 'string' || typeof claims.w !== 'string') return null;
		if (!Number.isSafeInteger(claims.e) || claims.e <= now) return null;
		return { previewId: claims.p, merchantId: claims.m, websiteId: claims.w, exp: claims.e };
	} catch {
		return null;
	}
};

/**
 * The page URL on the website's own origin (`https://<domain>`, or an allowlisted development origin), or null when
 * the path would leave it.
 * @param {string} origin
 * @param {string} path
 * @param {string} [search]
 */
export const targetUrl = (origin, path, search = '') => {
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 2000)
		return null;
	for (let i = 0; i < path.length; i += 1) {
		const code = path.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || /\s/.test(path.charAt(i))) return null;
	}
	try {
		const url = new URL(`${path}${search}`, `${origin}/`);
		if (url.origin !== origin || url.username || url.password) return null;
		url.hash = '';
		return url;
	} catch {
		return null;
	}
};

/**
 * Whether a fetched response is an HTML page the proxy may render.
 * @param {string | undefined} contentType
 */
export const isHtml = (contentType) =>
	HTML_TYPES.has(
		String(contentType ?? '')
			.split(';')[0]
			?.trim()
			.toLowerCase() ?? '',
	);

/**
 * Decode a page body using the declared charset (UTF-8 unless a known single-byte charset is declared).
 * @param {Uint8Array} body
 * @param {string | undefined} contentType
 */
export const decodePage = (body, contentType) => {
	const charset = /charset\s*=\s*"?([A-Za-z0-9_-]+)/i.exec(String(contentType ?? ''))?.[1]?.toLowerCase();
	const label =
		charset && ['iso-8859-1', 'latin1', 'windows-1252', 'us-ascii', 'ascii'].includes(charset) ? 'windows-1252' : 'utf-8';
	return new TextDecoder(label).decode(body);
};

/** @param {string} value */
const escapeAttribute = (value) =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Make script text safe inside an inline `<script>` element (no premature `</script>` or comment openers).
 * @param {string} script
 */
export const inlineScript = (script) => script.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const RIBBON_CSS =
	'#ss-preview-ribbon{position:fixed;z-index:2147483647;top:0;left:50%;transform:translateX(-50%);' +
	'background:#111;color:#fff;font:600 12px/1.6 system-ui,sans-serif;padding:4px 14px;border-radius:0 0 8px 8px;' +
	'letter-spacing:.04em;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)}';

/**
 * Inject the candidate bundle into a page: drop the page's own `<base>` and CSP `<meta>` elements, add
 * `<base href="<page url>">` first in `<head>` (relative assets load from the origin), the ribbon style and the
 * nonce-bearing bundle at the end of `<head>`, and the visible ribbon at the start of `<body>`.
 * @param {{ html: string, pageUrl: string, script: string, nonce: string, label?: string }} input
 */
export const injectPreview = ({ html, pageUrl, script, nonce, label = 'Preview' }) => {
	let out = html
		.replace(/<base\b[^>]*>/gi, '')
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*content-security-policy[^>]*>/gi, '');
	const base = `<base href="${escapeAttribute(pageUrl)}">`;
	const headEnd = `<style>${RIBBON_CSS}</style><script nonce="${escapeAttribute(nonce)}">${inlineScript(script)}</script>`;
	const ribbon = `<div id="ss-preview-ribbon" role="status" aria-live="polite">${escapeAttribute(label)}</div>`;

	const headOpen = /<head(?:\s[^>]*)?>/i.exec(out);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		out = `${out.slice(0, at)}${base}${out.slice(at)}`;
	} else {
		const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(out);
		const at = htmlOpen ? htmlOpen.index + htmlOpen[0].length : 0;
		out = `${out.slice(0, at)}<head>${base}</head>${out.slice(at)}`;
	}
	const headClose = /<\/head\s*>/i.exec(out);
	out = headClose ? `${out.slice(0, headClose.index)}${headEnd}${out.slice(headClose.index)}` : `${out}${headEnd}`;
	const bodyOpen = /<body(?:\s[^>]*)?>/i.exec(out);
	out = bodyOpen
		? `${out.slice(0, bodyOpen.index + bodyOpen[0].length)}${ribbon}${out.slice(bodyOpen.index + bodyOpen[0].length)}`
		: `${out}${ribbon}`;
	return out;
};

/**
 * Response headers of a preview page (`dedicated`: served from the dedicated preview origin).
 * @param {{ nonce: string, origin: string, portalOrigin: string, connectOrigins?: ReadonlyArray<string>, dedicated?: boolean }} input
 */
export const previewHeaders = ({ nonce, origin, portalOrigin, connectOrigins = [], dedicated = false }) => {
	const insecure = origin.startsWith('http:') ? ` ${origin}` : '';
	const csp = [
		dedicated
			? 'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'
			: 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
		`default-src https: data: blob:${insecure}`,
		// a nonce makes browsers ignore 'unsafe-inline': the dedicated origin lists none, so the merchant's inline
		// scripts run next to the injected bundle
		dedicated ? `script-src https: 'unsafe-inline' blob:${insecure}` : `script-src 'nonce-${nonce}' 'strict-dynamic'`,
		`style-src https: 'unsafe-inline'${insecure}`,
		`img-src https: data: blob:${insecure}`,
		`font-src https: data:${insecure}`,
		dedicated
			? `connect-src https: wss:${insecure}`
			: `connect-src ${[...new Set([portalOrigin, ...connectOrigins])].join(' ')}`,
		"object-src 'none'",
		`base-uri ${origin}`,
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join('; ');
	return {
		'content-type': 'text/html; charset=utf-8',
		'content-security-policy': csp,
		'cache-control': 'no-store',
		'x-robots-tag': 'noindex, nofollow, noarchive',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'same-origin',
	};
};
