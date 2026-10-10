/**
 * The Subscriptions admin widget (admin widget, ticket; PLAN 0.8.7, 0.6): a list-and-detail screen of the website's
 * subscriptions as Payments mirrors them from Stripe and PayPal (`subscriptions.read`), with a status filter and
 * paging. The detail shows every field and the history; its More menu copies the subscription's id and, last, cancels
 * it at the gateway after a confirmation (`subscriptions.cancel`). Times follow the website's Format and time zone.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { SUBSCRIPTION_STATUSES } from '../core/payments.js';
import { badge, dot, fieldGrid, fill, listSection, moreMenu, openDialog, splitView } from './admin-kit.js';
import { element } from './dom.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** The tone of each subscription status. @type {Record<string, import('./admin-kit.js').Tone>} */
const TONES = { pending: 'warning', active: 'success', past_due: 'danger', paused: 'warning' };

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig,
 *   copy?: (text: string) => void }} input `copy`: put a text on the clipboard
 */
export const mountSubscriptionsAdmin = ({ host, api, config, copy = () => {} }) => {
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
			const statusFilter = /** @type {HTMLSelectElement} */ (element(doc, 'select', { 'aria-label': t('subs.status') }));
			statusFilter.append(
				element(doc, 'option', { value: '' }, t('subs.all')),
				...SUBSCRIPTION_STATUSES.map((value) => element(doc, 'option', { value }, t(`subStatus.${value}`))),
			);
			const head = element(doc, 'div', { class: 'head' });
			head.append(element(doc, 'h2', {}, t('subs.title')), statusFilter);
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('subs.more'));
			const view = splitView(doc, t('subs.back'));
			view.list.append(list, more);
			const box = element(doc, 'section', { class: 'box' });
			box.append(head, status, view.root);
			root.append(box);
			/** @type {string | null} */
			let cursor = null;
			/** @type {Map<string, any>} */
			const shown = new Map();
			/** @param {any} answer */
			const failed = (answer) => (answer.status === 0 && !api.tickets.current() ? t('subs.signedOut') : t('subs.failed'));

			/** @param {any} subscription @param {boolean} [pick] */
			const details = (subscription, pick = false) => {
				for (const item of list.querySelectorAll('li.item'))
					item.setAttribute('aria-current', String(item.getAttribute('data-id') === subscription.id));
				const note = element(doc, 'p', { class: 'status', role: 'status' });
				/** @type {import('./admin-kit.js').MenuItem[]} */
				const menu = [{ label: t('subs.copyId'), onSelect: () => copy(subscription.id) }];
				if (subscription.status !== 'cancelled' && subscription.status !== 'expired')
					menu.push({
						label: t('subs.cancel'),
						danger: true,
						onSelect: () =>
							openDialog(root, {
								title: t('subs.cancel'),
								body: [element(doc, 'p', {}, fill(t('subs.cancelIntro'), { plan: subscription.plan }))],
								submitLabel: t('subs.cancel'),
								cancelLabel: t('subs.keep'),
								danger: true,
								onSubmit: async () => {
									const answer = await adminCall(api, 'POST', `/v1/admin/subscriptions/${subscription.id}/cancel`);
									if (!answer.ok) return fill(t('subs.cancelFailed'), { reason: answer.data?.detail ?? '' });
									shown.set(answer.data.id, answer.data);
									const item = list.querySelector(`li[data-id="${answer.data.id}"]`);
									if (item) row(answer.data, /** @type {HTMLElement} */ (item));
									details(answer.data);
									view.detail.querySelector('[role="status"]')?.replaceChildren(t('subs.cancelled'));
									return null;
								},
							}),
					});
				const heading = element(doc, 'h3', {}, subscription.reference || subscription.plan);
				heading.append(badge(doc, t(`subStatus.${subscription.status}`), TONES[subscription.status]));
				const top = element(doc, 'div', { class: 'head' });
				top.append(heading, moreMenu(doc, t('subs.moreActions'), menu));
				const customer = subscription.customer ?? {};
				const history = listSection(
					doc,
					t('subs.history'),
					subscription.history.map((/** @type {any} */ entry) =>
						[date(entry.at), entry.event, entry.detail ?? '', entry.by ?? ''].filter(Boolean).join(' · '),
					),
				);
				view.detail.replaceChildren(
					view.back,
					top,
					fieldGrid(doc, [
						[t('subs.field.gateway'), t(`gateway.${subscription.gateway}`)],
						[t('subs.field.plan'), subscription.plan],
						[t('subs.field.reference'), subscription.reference],
						[t('subs.field.name'), customer.name],
						[t('subs.field.email'), customer.email],
						[t('subs.field.phone'), customer.phone],
						[t('subs.field.customerId'), customer.id],
						[t('subs.field.gatewayReference'), subscription.gatewayReference],
						[t('subs.field.created'), date(subscription.createdAt)],
						[t('subs.field.updated'), subscription.updatedAt ? date(subscription.updatedAt) : ''],
						[t('subs.field.id'), subscription.id],
					]),
					...(history ? [history] : []),
					note,
				);
				if (pick) view.show('detail');
			};

			/** @param {any} subscription @param {HTMLElement} item */
			const row = (subscription, item) => {
				item.replaceChildren(
					dot(doc, TONES[subscription.status] ?? 'neutral', t(`subStatus.${subscription.status}`)),
					element(doc, 'span', { class: 'name' }, subscription.reference || subscription.plan),
					element(doc, 'span', { class: 'figure' }, t(`gateway.${subscription.gateway}`)),
					element(
						doc,
						'span',
						{ class: 'meta' },
						[t(`subStatus.${subscription.status}`), subscription.customer?.email ?? '', date(subscription.createdAt)]
							.filter(Boolean)
							.join(' · '),
					),
				);
			};

			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const params = new URLSearchParams({ limit: '25' });
				if (statusFilter.value) params.set('status', statusFilter.value);
				if (!fresh && cursor) params.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/subscriptions?${params.toString()}`);
				if (fresh) {
					list.replaceChildren();
					shown.clear();
				}
				if (!answer.ok) {
					status.textContent = failed(answer);
					more.setAttribute('hidden', '');
					return;
				}
				cursor = answer.data.nextCursor;
				status.textContent = fresh && answer.data.items.length === 0 ? t('subs.empty') : '';
				for (const subscription of answer.data.items) {
					shown.set(subscription.id, subscription);
					const item = element(doc, 'li', { class: 'item', tabindex: '0', 'data-id': subscription.id });
					row(subscription, item);
					const pick = () => details(shown.get(subscription.id), true);
					item.addEventListener('click', pick);
					item.addEventListener('keydown', (event) => {
						if (event.key === 'Enter' || event.key === ' ') pick();
					});
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
				if (fresh) {
					view.show('list');
					const first = answer.data.items[0];
					if (first) details(first);
					else view.detail.replaceChildren();
				}
			};
			statusFilter.addEventListener('change', () => void load(true));
			more.addEventListener('click', () => void load(false));
			const stop = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				view.detail.replaceChildren();
				status.textContent = t('subs.signedOut');
			});
			void load(true);
			return () => {
				stop();
			};
		},
	});
};
