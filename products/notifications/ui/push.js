/**
 * The push-permission widget (PLAN 0.8.5), for visitors (`push_permission`, browser token) and for the merchant's
 * staff (`staff_push_permission`, ticket). It asks the browser for permission, registers the merchant's service worker
 * (`/ss-notifications-sw.js` at the root of their website), subscribes with the merchant's public push key and sends
 * the subscription to Notifications. A visitor's subscriber id is kept in localStorage and announced with the
 * `ss-notifications:subscribed` event, so the merchant's site can link it to its user; visitors can turn it off again.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { SERVICE_WORKER_PATH, SUBSCRIBED_EVENT, SUBSCRIBER_STORAGE_KEY, keyBytes } from '../core/widgets.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/**
 * @typedef {object} PushInput
 * @property {HTMLElement} host
 * @property {Window & typeof globalThis} win
 * @property {'visitor' | 'staff'} kind
 * @property {import('./widget.js').WidgetConfig} config
 * @property {(subscription: unknown) => Promise<string | null>} save sends the subscription; the subscriber id, or null
 * @property {(subscriberId: string, endpoint: string) => Promise<void>} [remove] visitors: forget the subscription
 */

/** The widget texts of each kind (every word is editable in Settings → Texts). */
const TEXT_KEYS = Object.freeze({
	visitor: Object.freeze({
		title: 'push.title',
		ask: 'push.ask',
		enable: 'push.enable',
		disable: 'push.disable',
		enabled: 'push.enabled',
		blocked: 'push.blocked',
		unsupported: 'push.unsupported',
		failed: 'push.failed',
	}),
	staff: Object.freeze({
		title: 'staffPush.title',
		ask: 'staffPush.ask',
		enable: 'staffPush.enable',
		disable: 'push.disable',
		enabled: 'staffPush.enabled',
		blocked: 'staffPush.blocked',
		unsupported: 'staffPush.unsupported',
		failed: 'staffPush.failed',
	}),
});

/** @param {Window} win @returns {string | null} */
const storedId = (win) => {
	try {
		return win.localStorage.getItem(SUBSCRIBER_STORAGE_KEY);
	} catch {
		return null;
	}
};

/** @param {Window} win @param {string | null} id */
const storeId = (win, id) => {
	try {
		if (id === null) win.localStorage.removeItem(SUBSCRIBER_STORAGE_KEY);
		else win.localStorage.setItem(SUBSCRIBER_STORAGE_KEY, id);
	} catch {
		// private mode: the event still carries the id
	}
};

/**
 * @param {PushInput} input
 */
export const mountPushPermission = ({ host, win, kind, config, save, remove }) => {
	const keys = TEXT_KEYS[kind];
	/** @param {keyof typeof keys} name */
	const say = (name) => config.texts[keys[name]] ?? keys[name];
	const publicKey = config.settings.pushPublicKey;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const box = element(doc, 'section', { class: 'box' });
			const status = element(doc, 'p', { class: 'status', role: 'status' }, say('ask'));
			const enable = element(doc, 'button', { type: 'button' }, say('enable'));
			const disable = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, say('disable'));
			box.append(element(doc, 'h2', {}, say('title')), status, enable);
			if (kind === 'visitor') box.append(disable);
			root.append(box);

			const nav = /** @type {Navigator & { serviceWorker?: ServiceWorkerContainer }} */ (win.navigator);
			const supported = Boolean(nav.serviceWorker) && 'PushManager' in win && 'Notification' in win && Boolean(publicKey);
			/** @param {'ask' | 'enabled' | 'blocked' | 'unsupported' | 'failed'} state */
			const show = (state) => {
				status.textContent = say(state);
				const on = state === 'enabled';
				if (on || state === 'unsupported' || state === 'blocked') enable.setAttribute('hidden', '');
				else enable.removeAttribute('hidden');
				if (on && kind === 'visitor') disable.removeAttribute('hidden');
				else disable.setAttribute('hidden', '');
			};
			if (!supported) return show('unsupported');
			if (win.Notification.permission === 'denied') return show('blocked');
			if (kind === 'visitor' && win.Notification.permission === 'granted' && storedId(win)) show('enabled');

			enable.addEventListener('click', async () => {
				enable.setAttribute('disabled', '');
				try {
					const permission = await win.Notification.requestPermission();
					if (permission !== 'granted') return show(permission === 'denied' ? 'blocked' : 'ask');
					const registration = await /** @type {ServiceWorkerContainer} */ (nav.serviceWorker).register(SERVICE_WORKER_PATH);
					const subscription = await registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: keyBytes(/** @type {string} */ (publicKey)),
					});
					const subscriberId = await save(subscription.toJSON());
					if (!subscriberId) return show('failed');
					if (kind === 'visitor') {
						storeId(win, subscriberId);
						win.dispatchEvent(new win.CustomEvent(SUBSCRIBED_EVENT, { detail: { subscriberId } }));
					}
					show('enabled');
				} catch {
					show('failed');
				} finally {
					enable.removeAttribute('disabled');
				}
			});

			disable.addEventListener('click', async () => {
				const id = storedId(win);
				try {
					const registration = await /** @type {ServiceWorkerContainer} */ (nav.serviceWorker).getRegistration(
						SERVICE_WORKER_PATH,
					);
					const subscription = await registration?.pushManager.getSubscription();
					if (subscription) {
						if (id && remove) await remove(id, subscription.endpoint);
						await subscription.unsubscribe();
					}
				} catch {
					// the browser may already have dropped it
				}
				storeId(win, null);
				show('ask');
			});
			return undefined;
		},
	});
};
