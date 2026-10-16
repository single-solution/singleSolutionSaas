/**
 * `@ss/app-kit/widget` — the browser side of widgets (PLAN 0.4.10). No Node.js imports: products bundle it into their
 * own `widget.js`.
 *
 * `formatMoney` and `formatDate` are the kit's one formatter (PLAN 0.8.10 K7): widgets pass the website's Format and
 * business time zone from their widget config, and `viewerOf(window)` (the browser's language and time zone).
 * `toDecimal` and `fromDecimal` turn minor units into the plain decimal text of a money input and back, `isCurrency`
 * checks a currency code, and `toCsv` writes a CSV file (the formula guard included), the same as the server's.
 *
 * `mountWidget({ host, theme, css, customCss, render })` attaches an open Shadow DOM to `host`, so the site's CSS
 * cannot break the widget, and injects into that shadow root only: the theme as CSS variables
 * (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), the product CSS and the merchant's custom CSS. The mode is
 * set as `data-ss-mode="light" | "dark"` on the host (`auto` follows the device and updates when it changes), so
 * product CSS styles both with `:host([data-ss-mode="dark"])`. The text language and direction come from the page:
 * a shadow root inherits `lang` and `dir` from its host, so a page in Arabic or Hebrew shows the widget right to left
 * (the widget CSS uses logical properties). `lang` and `dir` options set them on the widget's root when the page does
 * not say.
 *
 * Every widget builds its elements with `element` (text as text, never HTML), calls JSON routes with `requestJson`, and
 * an admin widget calls its routes with `adminCall` and the ticket of `createTicketSource`. The admin widgets build
 * their screens from `badge`, `dot`, `fieldGrid`, `splitView`, `moreMenu` and `openDialog` (PLAN 0.6), and every widget builds
 * its controls from `toggle`, `checkbox`, `radio`, `radioGroup`, `segmented`, `checkGroup`, `field`, `affix`, `block` and `settingRow`, which
 * `CONTROLS_CSS` draws (a switch, a checkbox, a radio, a segmented control, a card) from the website's theme.
 * @module
 */
import { toCsv } from '@ss/contracts/csv';
import {
	DEFAULT_FORMAT,
	formatDate,
	formatMoney,
	fromDecimal,
	isCurrency,
	normalizeFormat,
	toDecimal,
} from '@ss/contracts/format';
import { formatText } from './text.js';

export { DEFAULT_FORMAT, formatDate, formatMoney, formatText, fromDecimal, isCurrency, normalizeFormat, toCsv, toDecimal };
export {
	badge,
	dot,
	emptyState,
	errorState,
	fieldGrid,
	loadingState,
	moreMenu,
	openDialog,
	splitView,
	stateSlot,
} from './widget/admin.js';
export { ADMIN_KIT_CSS } from './widget/admin-css.js';
export { CONTROLS_CSS } from './widget/controls-css.js';
export {
	affix,
	block,
	checkGroup,
	checkbox,
	field,
	fieldError,
	radio,
	radioGroup,
	segmented,
	settingRow,
	toggle,
} from './widget/controls.js';
export { element } from './widget/dom.js';
export { REFRESH_BEFORE_MS, adminCall, createTicketSource, requestJson } from './widget/tickets.js';

/** @typedef {import('./widget/tickets.js').Answer} Answer */
/** @typedef {import('./widget/tickets.js').Ticket} Ticket */
/** @typedef {import('./widget/tickets.js').GetTicket} GetTicket */
/** @typedef {import('./widget/tickets.js').TicketSource} TicketSource */
/** @typedef {import('./widget/tickets.js').AdminApi} AdminApi */
/** @typedef {import('./widget/admin.js').Tone} Tone */
/** @typedef {import('./widget/admin.js').MenuItem} MenuItem */
/** @typedef {import('./widget/admin.js').Child} Child */
/** @typedef {import('./widget/admin.js').DialogInput} DialogInput */
/** @typedef {import('./widget/controls.js').ChoiceOptions} ChoiceOptions */
/** @typedef {import('./widget/controls.js').GroupInput} GroupInput */

/**
 * The viewer of a widget: the browser's language and time zone (for a Format whose locale is '' and whose times are
 * `viewer`).
 * @param {{ navigator?: { language?: string } } | null | undefined} [win]
 * @returns {{ locale?: string, timeZone?: string }}
 */
export const viewerOf = (win) => {
	/** @type {{ locale?: string, timeZone?: string }} */
	const viewer = {};
	const language = win?.navigator?.language;
	if (typeof language === 'string' && language !== '') viewer.locale = language;
	try {
		const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (zone) viewer.timeZone = zone;
	} catch {
		// the runtime knows no time zones: the business time zone is used
	}
	return viewer;
};

/**
 * @typedef {{ colors?: Record<string, string>, fontFamily?: string, radius?: number, mode?: 'light' | 'dark' | 'auto' }} WidgetTheme
 */

const COLOR_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/**
 * The `:host` rule with the theme's CSS variables. Values that do not fit are left out.
 * @param {WidgetTheme} [theme]
 * @returns {string}
 */
export const themeCss = (theme = {}) => {
	/** @type {string[]} */
	const declarations = [];
	for (const [name, color] of Object.entries(theme.colors ?? {})) {
		if (COLOR_NAME.test(name) && typeof color === 'string' && COLOR.test(color))
			declarations.push(`--ss-color-${name}: ${color};`);
	}
	if (theme.fontFamily === 'inherit' || theme.fontFamily === undefined) declarations.push('--ss-font-family: inherit;');
	else if (FONT.test(theme.fontFamily)) declarations.push(`--ss-font-family: "${theme.fontFamily}", inherit;`);
	if (Number.isInteger(theme.radius) && /** @type {number} */ (theme.radius) >= 0 && /** @type {number} */ (theme.radius) <= 24)
		declarations.push(`--ss-radius: ${theme.radius}px;`);
	return `:host { ${declarations.join(' ')} }`;
};

/**
 * Mount a widget into `host`.
 * @param {{ host: HTMLElement, theme?: WidgetTheme, css?: string, customCss?: string, lang?: string,
 *   dir?: 'ltr' | 'rtl', render: (root: HTMLElement) => void | (() => void) }} options `render` fills the widget's root
 *   element and may return a cleanup function; `lang` (a language tag) and `dir` are set on the root only when given
 * @returns {{ root: HTMLElement, shadow: ShadowRoot, update: (next: { theme?: WidgetTheme, customCss?: string }) => void, unmount: () => void }}
 */
export const mountWidget = ({ host, theme = {}, css = '', customCss = '', lang, dir, render }) => {
	const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
	shadow.replaceChildren();
	const doc = /** @type {Document} */ (host.ownerDocument);
	const themeStyle = doc.createElement('style');
	const productStyle = doc.createElement('style');
	const customStyle = doc.createElement('style');
	productStyle.textContent = css;
	const root = doc.createElement('div');
	root.setAttribute('part', 'root');
	if (lang) root.setAttribute('lang', lang);
	if (dir === 'ltr' || dir === 'rtl') root.setAttribute('dir', dir);
	shadow.append(themeStyle, productStyle, customStyle, root);

	const view = doc.defaultView;
	const media = view && typeof view.matchMedia === 'function' ? view.matchMedia('(prefers-color-scheme: dark)') : null;
	let mode = theme.mode ?? 'auto';
	const applyMode = () => {
		host.setAttribute('data-ss-mode', mode === 'auto' ? (media?.matches ? 'dark' : 'light') : mode);
	};
	media?.addEventListener('change', applyMode);

	/** @param {{ theme?: WidgetTheme, customCss?: string }} next */
	const update = ({ theme: nextTheme, customCss: nextCss }) => {
		if (nextTheme) {
			themeStyle.textContent = themeCss(nextTheme);
			mode = nextTheme.mode ?? 'auto';
			applyMode();
		}
		if (nextCss !== undefined) customStyle.textContent = nextCss;
	};
	update({ theme, customCss });
	const cleanup = render(root);

	return {
		root,
		shadow,
		update,
		unmount: () => {
			media?.removeEventListener('change', applyMode);
			if (typeof cleanup === 'function') cleanup();
			shadow.replaceChildren();
			host.removeAttribute('data-ss-mode');
		},
	};
};
