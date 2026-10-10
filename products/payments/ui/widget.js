/**
 * Starts the widgets on a page (PLAN 0.4.10). `widget.js` is the same for every website. With `data-token` on its
 * script tag (the website's browser token) it fetches the website's widget config and mounts the pay buttons
 * (`data-ss-payments="pay_button"` with `data-link` or `data-payment`) while payment links or the payment API is on.
 * Without it (the merchant's admin pages) it only offers `window.SSPayments.admin({ getTicket })`, which fetches the
 * config with a ticket and mounts the admin widgets of switched-on features: `payments_admin` and
 * `subscriptions_admin`. Widgets render nothing while the product is stopped, their feature is off or the merchant
 * database is not connected.
 * @module
 */
import { WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountPayButton } from './pay-button.js';
import { mountPaymentsAdmin } from './payments-admin.js';
import { mountSubscriptionsAdmin } from './subscriptions-admin.js';
import { createTicketSource } from './tickets.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts the widget texts (the website's own, else the defaults)
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {Parameters<typeof import('@ss/app-kit/widget').formatMoney>[2]} format how money and dates look (Settings →
 *   Format, PLAN 0.8.10 K7)
 * @property {string} timeZone the business.json time zone (UTC when missing)
 * @property {string[]} features the switched-on features
 */

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
 * @param {{ window: Window & typeof globalThis, script: HTMLScriptElement | null }} input
 * @returns {{ admin: (options: { getTicket: import('./tickets.js').GetTicket }) => Promise<void>, ready: Promise<void> }}
 *   `admin` is the page's API (`window.SSPayments.admin`); `ready` settles once the visitor widgets are mounted
 */
export const startWidget = ({ window: win, script }) => {
	const doc = win.document;
	const base = new URL(script?.src ?? win.location.href).origin;
	const token = script?.dataset.token;
	/** @param {keyof typeof WIDGET_FEATURES} key */
	const hosts = (key) => /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)]);
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);
	/**
	 * @param {WidgetConfig} config @param {keyof typeof WIDGET_FEATURES} key
	 */
	const on = (config, key) => WIDGET_FEATURES[key].some((feature) => config.features.includes(feature));

	const ready = (async () => {
		if (!token) return;
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config || !on(config, 'pay_button')) return;
		/** @type {import('./pay-button.js').VisitorCall} */
		const call = async (path, init = {}) => {
			try {
				const response = await request(`${base}${path}`, {
					method: init.method ?? 'GET',
					headers: {
						authorization: `Bearer ${token}`,
						...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
					},
					...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				});
				return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
			} catch {
				return { ok: false, status: 0, data: null };
			}
		};
		await Promise.all(
			hosts('pay_button').map((host) => mountPayButton({ host, config, call, go: (url) => win.location.assign(url) })),
		);
	})();

	/** @param {{ getTicket: import('./tickets.js').GetTicket }} options */
	const admin = async ({ getTicket }) => {
		/** @type {import('./tickets.js').Ticket} */
		let first;
		try {
			first = await getTicket();
		} catch {
			return;
		}
		if (typeof first?.ticket !== 'string') return;
		const config = await loadConfig(request, `${base}${ADMIN_CONFIG_PATH}`, first.ticket);
		if (!config) return;
		const tickets = createTicketSource({
			first,
			getTicket,
			schedule: (task, ms) => win.setTimeout(task, ms),
			cancel: (id) => win.clearTimeout(id),
			now: () => Date.now(),
		});
		const api = { base, tickets, fetch: request };
		if (on(config, 'payments_admin'))
			for (const host of hosts('payments_admin'))
				mountPaymentsAdmin({
					host,
					api,
					config,
					open: (url) => void win.open(url, '_blank', 'noopener'),
					save: (name, text) => {
						const link = doc.createElement('a');
						link.href = win.URL.createObjectURL(new win.Blob([text], { type: 'text/csv;charset=utf-8' }));
						link.download = name;
						link.click();
						win.URL.revokeObjectURL(link.href);
					},
				});
		if (on(config, 'subscriptions_admin'))
			for (const host of hosts('subscriptions_admin')) mountSubscriptionsAdmin({ host, api, config });
	};
	Object.assign(win, { [WIDGET_GLOBAL]: Object.freeze({ admin }) });
	return { admin, ready };
};
