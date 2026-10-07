/**
 * Starts the widgets on a page (PLAN 0.4.10). `widget.js` is the same for every website. With `data-token` on its
 * script tag (the website's browser token) it fetches the website's widget config and mounts the visitor widgets of
 * switched-on features. Without it (the merchant's admin pages) it only offers `window.SS<Product>.admin({ getTicket })`,
 * which fetches the config with a ticket and mounts the admin widgets. Widgets mount only into the elements the
 * merchant placed (`data-ss-<id>="<widget key>"`), and render nothing while the product is stopped, their feature is
 * off or the merchant database is not connected.
 * @module
 */
import { WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountInbox } from './inbox.js';
import { mountNoteForm } from './note-form.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts the widget texts (the website's own, else the defaults)
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {string[]} features the switched-on features
 * @property {{ maxLength: number }} settings what the widgets need of the settings (`hooks.widgetConfig`)
 */

/** @typedef {{ ticket: string, expiresAt: string }} Ticket */
/** @typedef {() => Promise<Ticket>} GetTicket */

/**
 * @param {typeof globalThis.fetch} request
 * @param {string} url
 * @param {string} credential browser token or ticket
 * @returns {Promise<WidgetConfig | null>} null when the product says no (stopped, database not connected …)
 */
const loadConfig = async (request, url, credential) => {
	try {
		const response = await request(url, { headers: { authorization: `Bearer ${credential}` } });
		return response.ok ? /** @type {WidgetConfig} */ (await response.json()) : null;
	} catch {
		return null;
	}
};

/**
 * @param {{ window: Window, script: HTMLScriptElement | null }} input
 * @returns {{ admin: (options: { getTicket: GetTicket }) => Promise<void>, ready: Promise<void> }} `admin` is the page's
 *   API (`window.SS<Product>.admin`); `ready` settles once the visitor widgets are mounted (or not)
 */
export const startWidget = ({ window: win, script }) => {
	const doc = win.document;
	const base = new URL(script?.src ?? win.location.href).origin;
	const token = script?.dataset.token;
	/** @param {keyof typeof WIDGET_FEATURES} key */
	const hosts = (key) => /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)]);
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);

	const ready = (async () => {
		if (!token) return;
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config?.features.includes(WIDGET_FEATURES.note_form)) return;
		for (const host of hosts('note_form')) mountNoteForm({ host, base, token, config, fetch: request });
	})();

	/** @param {{ getTicket: GetTicket }} options */
	const admin = async ({ getTicket }) => {
		/** @type {Ticket} */
		let first;
		try {
			first = await getTicket();
		} catch {
			return;
		}
		if (typeof first?.ticket !== 'string') return;
		const config = await loadConfig(request, `${base}${ADMIN_CONFIG_PATH}`, first.ticket);
		if (!config?.features.includes(WIDGET_FEATURES.inbox)) return;
		for (const host of hosts('inbox'))
			mountInbox({
				host,
				base,
				first,
				getTicket,
				config,
				fetch: request,
				schedule: (task, ms) => win.setTimeout(task, ms),
				cancel: (id) => win.clearTimeout(id),
				now: () => Date.now(),
			});
	};
	Object.assign(win, { [WIDGET_GLOBAL]: Object.freeze({ admin }) });
	return { admin, ready };
};
