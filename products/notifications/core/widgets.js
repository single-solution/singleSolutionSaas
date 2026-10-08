/**
 * Names the widgets and the docs share (PLAN 0.4.10): the browser global of `widget.js` (`window.SSNotifications`)
 * and the attribute of the elements the merchant places for widgets (`<div data-ss-notifications="delivery_log">`).
 * @module
 */

/** The browser global `widget.js` sets: `window.SSNotifications.admin({ getTicket })`. */
export const WIDGET_GLOBAL = 'SSNotifications';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-notifications';

/** The feature each widget belongs to (manifest.json `widgets`): a widget mounts only while its feature is on. */
export const WIDGET_FEATURES = Object.freeze({
	push_permission: 'browser_push',
	staff_push_permission: 'staff_push',
	delivery_log: 'send_api',
	template_editor: 'send_api',
	send_message: 'send_api',
});

/** Where the browser keeps the visitor's push subscriber id (so the merchant's site can read it back). */
export const SUBSCRIBER_STORAGE_KEY = 'ss-notifications-subscriber';

/** The DOM event the push-permission widget fires on `window` with `{ subscriberId }` once the visitor subscribed. */
export const SUBSCRIBED_EVENT = 'ss-notifications:subscribed';

/** The service worker file the merchant hosts at the root of their website (the docs give its contents). */
export const SERVICE_WORKER_PATH = '/ss-notifications-sw.js';

/**
 * The service worker the merchant copies to `SERVICE_WORKER_PATH`: it shows each push (`{ title, body, url }`) and
 * opens its address when clicked.
 */
export const SERVICE_WORKER_SOURCE = `self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || '', { body: data.body || '', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
`;

/**
 * The browser key the push service needs: a base64url string to bytes.
 * @param {string} base64url
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const keyBytes = (base64url) => {
	const base64 = `${base64url.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (base64url.length % 4)) % 4)}`;
	const binary = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
};
