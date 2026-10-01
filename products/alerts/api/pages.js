/**
 * Hosted link pages (the links inside alert messages): `GET /u/{token}` and `GET /c/{token}` only **show** a confirm
 * button — mail scanners, chat apps and link previews fetch URLs, so a GET never changes anything; the form POSTs to
 * the same URL. `POST /u/{token}` also accepts RFC 8058 one-click unsubscribe (`List-Unsubscribe=One-Click`) from mail
 * clients. Pages are static HTML (no scripts, CSP `default-src 'none'`), strings from the catalog in the
 * subscription's language, every value escaped.
 */
import { catalogText } from '../core/dispatch.js';
import { subscriptionView } from '../core/views.js';

/** @param {string} text */
export const escapeHtml = (text) =>
	text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const PAGE_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex, nofollow',
	'x-content-type-options': 'nosniff',
});

/**
 * @param {{ lang: string, title: string, body: string, action?: { url: string, label: string } }} page
 * @param {number} [status]
 */
export const renderPage = ({ lang, title, body, action }, status = 200) =>
	new Response(
		`<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}main{max-width:28rem;padding:2rem;text-align:center}button{font:inherit;padding:.6rem 1.4rem;border-radius:999px;border:1px solid CanvasText;background:CanvasText;color:Canvas;cursor:pointer}button:focus-visible{outline:3px solid Highlight;outline-offset:2px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${
			action
				? `<form method="post" action="${escapeHtml(action.url)}"><button type="submit">${escapeHtml(action.label)}</button></form>`
				: ''
		}</main></body></html>`,
		{ status, headers: PAGE_HEADERS },
	);

/**
 * @param {{ alerts: import('./service.js').Alerts }} deps
 */
export const createPages = ({ alerts }) => {
	const { capture, siteFor, deps } = alerts;
	/**
	 * @param {string} lang
	 * @param {string} key
	 * @param {Record<string, string>} [values]
	 */
	const t = (lang, key, values = {}) => catalogText(key, values, { catalogs: deps.strings, lang, defaultLang: 'en' });
	/** @param {string} lang */
	const invalid = (lang) => renderPage({ lang, title: t(lang, 'page.invalid.title'), body: t(lang, 'page.invalid.body') }, 404);
	/** @param {string} lang */
	const unavailable = (lang) =>
		renderPage({ lang, title: t(lang, 'page.unavailable.title'), body: t(lang, 'page.unavailable.body') }, 503);

	/**
	 * Resolve a link: verified token → site (unsubscribe works whatever element switches say, as long as the website's
	 * data is reachable — an opt-out must always be honoured) → subscription.
	 * @param {'unsubscribe' | 'confirm'} purpose
	 * @param {string} token
	 */
	const resolve = async (purpose, token) => {
		const claims = deps.tokens.verify(purpose, token);
		if (!claims) return { state: /** @type {const} */ ('invalid') };
		/** @type {import('./service.js').Site | null} */
		let site = null;
		try {
			site = await siteFor(claims.websiteId, { element: purpose === 'confirm' ? 'capture' : 'types' });
		} catch {
			return { state: /** @type {const} */ ('unavailable') };
		}
		if (!site) return { state: /** @type {const} */ ('unavailable') };
		const sub = await site.repos.subscriptions.get(claims.subscriptionId);
		if (!sub || sub.contactKey !== claims.contactKey) return { state: /** @type {const} */ ('invalid') };
		return { state: /** @type {const} */ ('ok'), site, sub, claims };
	};

	/**
	 * @param {any} sub
	 */
	const labels = (sub) => {
		const v = subscriptionView(sub);
		return { contact: v.contactMasked ?? '', item: sub.item?.name ?? t(sub.lang, 'page.item.fallback') };
	};

	return Object.freeze({
		/**
		 * @param {string} token
		 * @param {string} selfUrl
		 */
		unsubscribeForm: async (token, selfUrl) => {
			const found = await resolve('unsubscribe', token);
			if (found.state === 'invalid') return invalid('en');
			if (found.state === 'unavailable') return unavailable('en');
			const { site, sub } = found;
			const values = labels(sub);
			const scope = site.settings.unsubscribe.scope;
			return renderPage({
				lang: sub.lang,
				title: t(sub.lang, 'page.unsubscribe.title'),
				body: t(
					sub.lang,
					scope === 'contact' ? 'page.unsubscribe.body.contact' : 'page.unsubscribe.body.subscription',
					values,
				),
				action: { url: selfUrl, label: t(sub.lang, 'page.unsubscribe.button') },
			});
		},
		/** @param {string} token */
		unsubscribe: async (token) => {
			const found = await resolve('unsubscribe', token);
			if (found.state === 'invalid') return invalid('en');
			if (found.state === 'unavailable') return unavailable('en');
			const { site, sub, claims } = found;
			const done = await capture.unsubscribe(site, claims);
			if (!done.ok) return invalid(sub.lang);
			return renderPage({
				lang: sub.lang,
				title: t(sub.lang, 'page.unsubscribe.done.title'),
				body: t(sub.lang, 'page.unsubscribe.done.body', labels(sub)),
			});
		},
		/**
		 * @param {string} token
		 * @param {string} selfUrl
		 */
		confirmForm: async (token, selfUrl) => {
			const found = await resolve('confirm', token);
			if (found.state === 'invalid') return invalid('en');
			if (found.state === 'unavailable') return unavailable('en');
			const { sub } = found;
			return renderPage({
				lang: sub.lang,
				title: t(sub.lang, 'page.confirm.title'),
				body: t(sub.lang, 'page.confirm.body', labels(sub)),
				action: { url: selfUrl, label: t(sub.lang, 'page.confirm.button') },
			});
		},
		/** @param {string} token */
		confirm: async (token) => {
			const found = await resolve('confirm', token);
			if (found.state === 'invalid') return invalid('en');
			if (found.state === 'unavailable') return unavailable('en');
			const { site, sub, claims } = found;
			const done = await capture.confirm(site, claims);
			if (!done.ok) return invalid(sub.lang);
			return renderPage({
				lang: sub.lang,
				title: t(sub.lang, 'page.confirm.done.title'),
				body: t(sub.lang, 'page.confirm.done.body', labels(sub)),
			});
		},
	});
};
