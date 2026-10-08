/**
 * Starts the widgets on a page (PLAN 0.4.10, 0.8.6). `widget.js` is the same for every website. With `data-token` on
 * its script tag (the website's browser token) it fetches the website's widget config and, while any sign-in method is
 * on, runs the visitor's session (kept from the last visit, renewed before it expires), handles the links Accounts
 * sends people to (`#ss_accounts_code=`, `#ss_accounts_link=`, `#ss_accounts_reset=`, `#ss_accounts_invite=`, removed
 * from the address bar at once) and mounts `sign_in` and `my_account`. `window.SSAccounts` offers `getSignIn()`,
 * `user()`, `signOut()`, `ready` and `admin({ getTicket })`, which fetches the config with a ticket and mounts the admin
 * widgets `users_admin` and `roles_admin` while Roles is on. Widgets mount only into the elements the merchant placed
 * (`data-ss-accounts="<widget key>"`), and render nothing while the product is stopped or their features are off.
 * @module
 */
import { LINK_PARAMS, SIGN_IN_METHODS, WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountMyAccount } from './my-account.js';
import { mountRolesAdmin } from './roles-admin.js';
import { createSession } from './session.js';
import { mountSignIn } from './sign-in.js';
import { createTicketSource } from './tickets.js';
import { mountUsersAdmin } from './users-admin.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';
/** The fragment parameter of a social sign-in that did not work (its value is a problem code). */
const ERROR_PARAM = LINK_PARAMS.error;

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts the widget texts (the website's own, else the defaults)
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {string[]} features the switched-on features
 * @property {WidgetSettings} settings
 */

/**
 * @typedef {object} WidgetSettings
 * @property {{ mode: 'open' | 'invite' | 'approval', requiredFields: Array<'name' | 'email' | 'phone'> }} signUp
 * @property {import('./common.js').CustomField[]} customFields
 * @property {number} passwordMinLength
 * @property {{ version: string, url: string } | null} terms
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
 * Read the link this page was opened with and remove it from the address bar (secrets never stay in the URL).
 * @param {Window} win
 * @returns {import('./sign-in.js').Link | null}
 */
const takeLink = (win) => {
	const params = new URLSearchParams(win.location.hash.slice(1));
	/** @type {Array<[import('./sign-in.js').Link['kind'], string]>} */
	const kinds = [
		['handoff', LINK_PARAMS.handoff],
		['magic', LINK_PARAMS.magic],
		['reset', LINK_PARAMS.reset],
		['invite', LINK_PARAMS.invite],
		['error', ERROR_PARAM],
	];
	const found = kinds.find(([, param]) => params.has(param));
	if (!found) return null;
	win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
	return { kind: found[0], value: params.get(found[1]) ?? '' };
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
	/** @param {keyof typeof WIDGET_FEATURES} key */
	const hosts = (key) => /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)]);
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);
	/** @type {import('./session.js').Session | null} */
	let session = null;

	const ready = (async () => {
		if (!token) return;
		const link = takeLink(win);
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config || !SIGN_IN_METHODS.some((method) => config.features.includes(method))) return;
		const current = createSession({ win, base, token, schedule, cancel, now });
		session = current;
		await current.restore();
		const signIns = hosts('sign_in');
		signIns.forEach((host, index) => mountSignIn({ host, win, config, session: current, link: index === 0 ? link : null }));
		for (const host of hosts('my_account')) mountMyAccount({ host, win, config, session: current });
		if (signIns.length === 0 && link && (link.kind === 'handoff' || link.kind === 'magic')) {
			// no sign-in widget on this page: finish a social sign-in or a magic link without one
			const answer =
				link.kind === 'handoff'
					? await current.call('POST', '/v1/sign-in/exchange', { code: link.value })
					: await current.call('POST', '/v1/sign-in/email', { link: link.value, deviceId: current.deviceId() });
			if (answer.ok && answer.data?.status === 'signed_in') current.accept(answer.data);
		}
	})();

	/** The current sign-in token (renewed when needed), or null. */
	const getSignIn = async () => {
		await ready;
		return session ? session.getSignIn() : null;
	};
	/** The signed-in user, or null. */
	const user = () => session?.user() ?? null;
	/** Sign out on this browser. */
	const signOut = async () => {
		await ready;
		await session?.signOut();
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
		const tickets = createTicketSource({ first, getTicket, schedule, cancel, now });
		const api = { base, tickets, fetch: request };
		/** @param {'users_admin' | 'roles_admin'} key */
		const on = (key) => WIDGET_FEATURES[key].some((feature) => config.features.includes(feature));
		if (on('users_admin')) for (const host of hosts('users_admin')) mountUsersAdmin({ host, api, config });
		if (on('roles_admin')) for (const host of hosts('roles_admin')) mountRolesAdmin({ host, api, config });
	};

	Object.assign(win, { [WIDGET_GLOBAL]: Object.freeze({ getSignIn, user, signOut, admin, ready }) });
	return { getSignIn, user, signOut, admin, ready };
};
