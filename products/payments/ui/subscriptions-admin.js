/**
 * The Subscriptions admin widget (admin widget, ticket; PLAN 0.8.7): the website's subscriptions as Payments mirrors
 * them from Stripe and PayPal (`subscriptions.read`), and Cancel, which cancels at the gateway
 * (`subscriptions.cancel`). Times follow the website's Format and time zone.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { element } from './dom.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** @param {string} text @param {Record<string, string>} values */
const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountSubscriptionsAdmin = ({ host, api, config }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const { date } = formattersOf(config, host);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('subs.more'));
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('subs.title')), status, list, more);
			root.append(box);
			/** @type {string | null} */
			let cursor = null;

			/** @param {any} subscription @param {HTMLElement} item */
			const row = (subscription, item) => {
				const summary = element(
					doc,
					'span',
					{},
					[t(`subStatus.${subscription.status}`), subscription.reference || subscription.plan].filter(Boolean).join(' · '),
				);
				const meta = element(
					doc,
					'span',
					{ class: 'meta' },
					[
						t(`gateway.${subscription.gateway}`),
						subscription.plan,
						subscription.customer?.email ?? '',
						date(subscription.createdAt),
						subscription.id,
					]
						.filter(Boolean)
						.join(' · '),
				);
				item.replaceChildren(summary, meta);
				if (subscription.status === 'cancelled' || subscription.status === 'expired') return;
				const cancel = element(doc, 'button', { type: 'button', class: 'secondary' }, t('subs.cancel'));
				cancel.addEventListener('click', async () => {
					cancel.setAttribute('disabled', '');
					const answer = await adminCall(api, 'POST', `/v1/admin/subscriptions/${subscription.id}/cancel`);
					cancel.removeAttribute('disabled');
					if (!answer.ok) {
						status.textContent = fill(t('subs.cancelFailed'), { reason: answer.data?.detail ?? '' });
						return;
					}
					status.textContent = t('subs.cancelled');
					row(answer.data, item);
				});
				item.append(cancel);
			};

			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const params = new URLSearchParams({ limit: '25' });
				if (!fresh && cursor) params.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/subscriptions?${params.toString()}`);
				if (fresh) list.replaceChildren();
				if (!answer.ok) {
					status.textContent = answer.status === 0 && !api.tickets.current() ? t('subs.signedOut') : t('subs.failed');
					more.setAttribute('hidden', '');
					return;
				}
				cursor = answer.data.nextCursor;
				status.textContent = fresh && answer.data.items.length === 0 ? t('subs.empty') : '';
				for (const subscription of answer.data.items) {
					const item = element(doc, 'li');
					row(subscription, item);
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
			};
			more.addEventListener('click', () => void load(false));
			const stop = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				status.textContent = t('subs.signedOut');
			});
			void load(true);
			return () => {
				stop();
			};
		},
	});
};
