/**
 * Starts the Chat widgets on a page (PLAN 0.4.10, 0.8.3). `widget.js` is the same for every website. With `data-token`
 * on its script tag (the website's browser token) it fetches the widget config and, while Visitor chat is on and the
 * page is not hidden by the merchant, mounts the visitor chat into a host element of its own. `window.SSChat` offers
 * `identify(token | null)`, `setPage({ kind, productId?, productName? })`, `onUnread(callback)`, `open()`, `close()`,
 * `ready` and `admin({ getTicket })`, which fetches the config with a ticket and mounts the admin widgets `inbox`,
 * `knowledge_editor` and `reports` into the elements the merchant placed (`data-ss-chat="<widget key>"`) while their
 * features are on. Nothing renders while the product is stopped.
 * @module
 */
import { pathMatches } from '../core/text.js';
import { PAGE_KINDS, WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountChat } from './chat.js';
import { requestJson, settingsOf } from './common.js';
import { mountInbox } from './inbox.js';
import { mountKnowledge } from './knowledge.js';
import { mountReports } from './reports.js';
import { adminCall, createTicketSource } from './tickets.js';
import { createChecks } from './transport.js';
import { createVisitor } from './visitor.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';

/**
 * @param {typeof globalThis.fetch} request
 * @param {string} url
 * @param {string} credential browser token or ticket
 * @returns {Promise<import('./common.js').WidgetConfig | null>} null when the product says no
 */
const loadConfig = async (request, url, credential) => {
	const answer = await requestJson(request, url, { headers: { authorization: `Bearer ${credential}` } });
	return answer.ok && answer.data ? answer.data : null;
};

/**
 * @typedef {object} StartInput
 * @property {Window & typeof globalThis} window
 * @property {HTMLScriptElement | null} script
 * @property {(task: () => void, ms: number) => number} [schedule] timers (tests inject their own)
 * @property {(id: number) => void} [cancel]
 * @property {() => number} [now]
 */

/**
 * @param {StartInput} input
 */
export const startWidget = ({
	window: win,
	script,
	schedule = (task, ms) => win.setTimeout(task, ms),
	cancel = (id) => win.clearTimeout(id),
	now = () => Date.now(),
}) => {
	const doc = win.document;
	const base = new URL(script?.src ?? win.location.href).origin;
	const token = script?.dataset.token;
	const clock = { schedule, cancel, now };
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);
	const visitor = token ? createVisitor({ win, base, token, now }) : null;
	/** @type {import('./chat.js').PageInfo | null} */
	let pageInfo = null;
	/** @type {import('./chat.js').ChatWidget | null} */
	let chat = null;
	/** @type {Set<(count: number, source: 'chat' | 'inbox') => void>} */
	const listeners = new Set();
	/** @type {{ chat?: number, inbox?: number }} */
	const counts = {};
	/** @param {'chat' | 'inbox'} source @param {number} count */
	const report = (source, count) => {
		counts[source] = count;
		for (const listener of listeners) listener(count, source);
	};

	const ready = (async () => {
		if (!visitor || !token) return;
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config?.features?.includes(WIDGET_FEATURES.chat)) return;
		const path = win.location.pathname;
		if (settingsOf(config).look.hideOnPages.some((pattern) => pathMatches(pattern, path))) return;
		const host = doc.createElement('div');
		host.setAttribute(WIDGET_ATTRIBUTE, 'chat');
		doc.body.append(host);
		chat = mountChat({ win, host, config, visitor, clock, page: () => pageInfo, onUnread: (count) => report('chat', count) });
	})();

	/** @param {string | null} signIn an Accounts sign-in, or null on sign-out */
	const identify = async (signIn) => {
		visitor?.identify(signIn);
		await ready;
		await chat?.reload();
	};
	/** @param {{ kind?: unknown, productId?: unknown, productName?: unknown } | null} context */
	const setPage = (context) => {
		const kind = /** @type {readonly unknown[]} */ (PAGE_KINDS).includes(context?.kind) ? String(context?.kind) : 'other';
		pageInfo = {
			kind,
			...(typeof context?.productId === 'string' ? { productId: context.productId } : {}),
			...(typeof context?.productName === 'string' ? { productName: context.productName } : {}),
		};
	};
	/** @param {(count: number, source: 'chat' | 'inbox') => void} callback @returns {() => void} unsubscribe */
	const onUnread = (callback) => {
		listeners.add(callback);
		for (const source of /** @type {const} */ (['chat', 'inbox'])) {
			const count = counts[source];
			if (count !== undefined) callback(count, source);
		}
		return () => void listeners.delete(callback);
	};
	const open = async () => {
		await ready;
		await chat?.open();
	};
	const close = async () => {
		await ready;
		chat?.close();
	};

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
		const tickets = createTicketSource({ first, getTicket, ...clock });
		const api = { base, tickets, fetch: request };
		/** @param {'inbox' | 'knowledge_editor' | 'reports'} key */
		const hosts = (key) =>
			config.features.includes(WIDGET_FEATURES[key])
				? /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)])
				: [];
		const inboxes = hosts('inbox');
		for (const host of inboxes) mountInbox({ host, win, api, config, clock, onUnread: (count) => report('inbox', count) });
		for (const host of hosts('knowledge_editor')) mountKnowledge({ host, api, config });
		for (const host of hosts('reports')) mountReports({ host, api, config, now });
		if (inboxes.length > 0) {
			const checks = createChecks({
				win,
				...clock,
				check: async () => {
					const answer = await adminCall(api, 'GET', '/v1/admin/inbox/unread');
					if (answer.ok && typeof answer.data?.unread === 'number') report('inbox', answer.data.unread);
				},
			});
			checks.start();
		}
	};

	const api = Object.freeze({ identify, setPage, onUnread, open, close, admin, ready });
	Object.assign(win, { [WIDGET_GLOBAL]: api });
	return api;
};
