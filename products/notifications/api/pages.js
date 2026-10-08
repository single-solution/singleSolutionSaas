/**
 * The hosted unsubscribe page (PLAN 0.8.5): served by Notifications at `/unsubscribe/<websiteId>/<code>`, with the
 * website's widget texts (every word editable in Settings → Texts), theme and custom CSS. Opening the link only asks;
 * the button (a form POST, also used by e-mail clients' one-click unsubscribe) unsubscribes. Plain HTML; every value
 * is escaped and the page runs no script.
 * @module
 */
import { themeCss } from '@ss/app-kit/widget';
import { formatText } from '@ss/app-kit';

/** Security headers of the hosted page. */
export const PAGE_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
});

/** @param {unknown} value */
const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${/** @type {string} */ (ch).charCodeAt(0)};`);

const PAGE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  font-family: var(--ss-font-family, system-ui, sans-serif); background: Canvas; color: CanvasText; }
.box { max-width: 420px; width: 100%; padding: 24px; border-radius: var(--ss-radius, 8px);
  background: var(--ss-color-background, Canvas); color: var(--ss-color-text, CanvasText);
  border: 1px solid var(--ss-color-border, GrayText); }
h1 { font-size: 1.3em; margin: 0 0 12px; }
button { font: inherit; padding: 10px 18px; border: 0; border-radius: var(--ss-radius, 8px); cursor: pointer;
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
`;

/**
 * The page.
 * @param {{ texts: Record<string, string>, theme?: import('@ss/app-kit/widget').WidgetTheme & { customCss?: string },
 *   state: 'ask' | 'done' | 'invalid' | 'unavailable', business?: string, action?: string }} input
 * @returns {string}
 */
export const renderUnsubscribePage = ({ texts, theme, state, business = '', action = '' }) => {
	/** @param {string} key */
	const t = (key) => texts[key] ?? key;
	const mode = theme?.mode === 'dark' || theme?.mode === 'light' ? `:root { color-scheme: ${theme.mode}; }` : '';
	const variables = theme ? themeCss(theme).replace(':host', ':root') : '';
	// custom CSS stays inside its style element
	const custom = (theme?.customCss ?? '').replace(/</g, '\\3c ');
	const body =
		state === 'ask'
			? `<p>${escape(formatText(t('unsubscribe.question'), { business }))}</p><form method="post" action="${escape(action)}"><button type="submit">${escape(t('unsubscribe.button'))}</button></form>`
			: `<p>${escape(t(`unsubscribe.${state}`))}</p>`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(t('unsubscribe.title'))}</title>
<style>${variables}${mode}${PAGE_CSS}</style>
<style>${custom}</style>
</head>
<body>
<main class="box">
<h1>${escape(t('unsubscribe.title'))}</h1>
${body}
</main>
</body>
</html>
`;
};
