/**
 * Starts the widgets on a page (PLAN 0.4.10). `widget.js` is the same for every website. With `data-token` on its
 * script tag (the website's browser token) it fetches the website's widget config and mounts the visitor widget
 * `push_permission` while browser push is on. Without it (the merchant's admin pages) it only offers
 * `window.SSNotifications.admin({ getTicket })`, which fetches the config with a ticket and mounts the admin widgets of
 * switched-on features: `delivery_log`, `template_editor`, `send_message` and `staff_push_permission`. Widgets mount
 * only into the elements the merchant placed (`data-ss-notifications="<widget key>"`), and render nothing while the
 * product is stopped, their feature is off or the merchant database is not connected.
 * @module
 */
import { WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountDeliveryLog } from './delivery-log.js';
import { mountPushPermission } from './push.js';
import { mountSendMessage } from './send-message.js';
import { mountTemplateEditor } from './template-editor.js';
import { adminCall, createTicketSource } from './tickets.js';

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
 * @property {{ pushPublicKey: string | null }} settings the merchant's public push key (`hooks.widgetConfig`)
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
 *   `admin` is the page's API (`window.SSNotifications.admin`); `ready` settles once the visitor widgets are mounted
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
		if (!config?.features.includes(WIDGET_FEATURES.push_permission)) return;
		/** @param {string} path @param {unknown} body */
		const post = (path, body) =>
			request(`${base}${path}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		for (const host of hosts('push_permission'))
			mountPushPermission({
				host,
				win,
				kind: 'visitor',
				config,
				save: async (subscription) => {
					const response = await post('/v1/push/subscriptions', { subscription });
					return response.ok ? /** @type {{ subscriberId: string }} */ (await response.json()).subscriberId : null;
				},
				remove: async (subscriberId, endpoint) => {
					await post('/v1/push/subscriptions/remove', { subscriberId, endpoint });
				},
			});
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
		/** @param {keyof typeof WIDGET_FEATURES} key */
		const on = (key) => config.features.includes(WIDGET_FEATURES[key]);
		if (on('delivery_log')) for (const host of hosts('delivery_log')) mountDeliveryLog({ host, api, config });
		if (on('template_editor')) for (const host of hosts('template_editor')) mountTemplateEditor({ host, api, config });
		if (on('send_message')) for (const host of hosts('send_message')) mountSendMessage({ host, api, config });
		if (on('staff_push_permission'))
			for (const host of hosts('staff_push_permission'))
				mountPushPermission({
					host,
					win,
					kind: 'staff',
					config,
					save: async (subscription) => {
						const answer = await adminCall(api, 'POST', '/v1/admin/push/subscriptions', { subscription });
						return answer.ok ? answer.data.subscriberId : null;
					},
				});
	};
	Object.assign(win, { [WIDGET_GLOBAL]: Object.freeze({ admin }) });
	return { admin, ready };
};
