/**
 * The page an alert message's stop link opens (visitor widget `alerts_stop`, feature alerts; PLAN 0.8.10 E34, EN-1):
 * placed on the merchant's stop page — the `alerts` setting `stopUrl`, by default `/alerts/unsubscribe/<token>` — as
 * `<div data-ss-ecommerce="alerts_stop"></div>`. The token is the page address's `token` query value, else its last
 * path segment. The shopper presses Stop (a mail scanner that opens the link stops nothing), and every alert of the
 * phone or email that message went to is removed (`POST /v1/shop/alerts/unsubscribe/:token`).
 * @module
 */
import { button, h, mountShop, textsOf } from './shop-common.js';

/** A stop token: 32 letters and digits (an order key's alphabet). */
const TOKEN = /^[A-Za-z0-9]{32}$/;

/**
 * The stop token of the page address, or ''.
 * @param {URL} url
 */
export const stopTokenOf = (url) => {
	const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
	const token = url.searchParams.get('token') ?? last;
	return TOKEN.test(token) ? token : '';
};

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountAlertsStop = async ({ host, config, shop }) => {
	const t = textsOf(config);
	const token = stopTokenOf(shop.location());
	mountShop({
		host,
		config,
		name: 'alerts-stop',
		render: (root) => {
			const doc = root.ownerDocument;
			const said = h(doc, 'p', { class: 'status', role: 'status' });
			if (!token) {
				said.textContent = t('alertsStop.noLink');
				root.append(said);
				return;
			}
			const stop = button(doc, t('alertsStop.stop'), async () => {
				stop.setAttribute('disabled', '');
				const answer = await shop.call(`/v1/shop/alerts/unsubscribe/${token}`, { method: 'POST' });
				if (!answer.ok) {
					stop.removeAttribute('disabled');
					said.textContent = t('alertsStop.failed');
					return;
				}
				stop.remove();
				said.textContent = t(Number(answer.data?.removed) > 0 ? 'alertsStop.stopped' : 'alertsStop.none');
			});
			root.append(h(doc, 'p', {}, t('alertsStop.intro')), stop, said);
		},
	});
};
