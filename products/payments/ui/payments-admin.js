/**
 * The Payments admin widget (admin widget, ticket; PLAN 0.8.7): the website's payments, newest first, with search by
 * id, reference or e-mail and a status filter; each payment's details and history; refunds (full or partial,
 * `payments.refund`), confirming a bank transfer and viewing its proof (`payments.confirm`); and a CSV export of the
 * payments that match the filters. Amounts and times follow the website's Format and time zone; the CSV keeps the
 * stored times and the amounts with their currency codes.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { fromDecimal, toDecimal } from '../core/money.js';
import { PAYMENT_STATUSES, paymentsCsv } from '../core/payments.js';
import { element } from './dom.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** Rows fetched per page, and pages an export reads at most. */
const PAGE_SIZE = 25;
const EXPORT_PAGES = 20;

/** @param {string} text @param {Record<string, string>} values */
const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig,
 *   save: (name: string, text: string) => void, open: (url: string) => void }} input `save`: hand a file to the browser;
 *   `open`: open an address in a new tab
 */
export const mountPaymentsAdmin = ({ host, api, config, save, open }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const can = (/** @type {string} */ feature) => config.features.includes(feature);
	const { money, date } = formattersOf(config, host);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const search = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { 'aria-label': t('admin.search'), placeholder: t('admin.search') })
			);
			const statusFilter = /** @type {HTMLSelectElement} */ (element(doc, 'select', { 'aria-label': t('admin.status') }));
			statusFilter.append(
				element(doc, 'option', { value: '' }, t('admin.all')),
				...PAYMENT_STATUSES.map((status) => element(doc, 'option', { value: status }, t(`status.${status}`))),
			);
			const searchButton = element(doc, 'button', { type: 'submit', class: 'secondary' }, t('admin.searchButton'));
			const exportButton = element(doc, 'button', { type: 'button', class: 'secondary' }, t('admin.export'));
			const filters = element(doc, 'form', { class: 'row' });
			filters.append(search, statusFilter, searchButton);
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('admin.more'));
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('admin.title')), filters, exportButton, status, list, more);
			root.append(box);

			/** @type {string | null} */
			let cursor = null;
			/** @param {string | null} next */
			const query = (next) => {
				const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
				if (search.value.trim()) params.set('q', search.value.trim());
				if (statusFilter.value) params.set('status', statusFilter.value);
				if (next) params.set('cursor', next);
				return `/v1/admin/payments?${params.toString()}`;
			};
			/** @param {{ ok: boolean, status: number }} answer */
			const failed = (answer) => (answer.status === 0 && !api.tickets.current() ? t('admin.signedOut') : t('admin.failed'));

			/**
			 * One payment's details: history, refund, confirm and proof.
			 * @param {any} payment @param {HTMLElement} item
			 */
			const details = (payment, item) => {
				item.querySelector('.details')?.remove();
				const panel = element(doc, 'div', { class: 'details' });
				const note = element(doc, 'p', { class: 'status', role: 'status' });
				const history = element(doc, 'ul');
				history.append(
					...payment.history.map((/** @type {any} */ entry) =>
						element(
							doc,
							'li',
							{},
							[date(entry.at), entry.event, entry.detail ?? '', entry.by ?? ''].filter(Boolean).join(' · '),
						),
					),
				);
				panel.append(element(doc, 'strong', {}, t('admin.history')), history);
				/** @param {any} next */
				const refresh = (next) => {
					row(next, item);
					details(next, item);
				};
				const left = payment.amount - payment.refunded;
				if (can('refunds') && (payment.status === 'paid' || payment.status === 'partially_refunded') && left > 0) {
					const amount = /** @type {HTMLInputElement} */ (
						element(doc, 'input', {
							inputmode: 'decimal',
							'aria-label': fill(t('admin.refundAmount'), { currency: payment.currency }),
						})
					);
					amount.value = toDecimal(left, payment.currency);
					const reason = /** @type {HTMLInputElement} */ (
						element(doc, 'input', { maxlength: '200', 'aria-label': t('admin.refundReason') })
					);
					const refund = element(doc, 'form', {});
					refund.append(
						element(doc, 'label', {}, fill(t('admin.refundAmount'), { currency: payment.currency })),
						amount,
						element(doc, 'label', {}, t('admin.refundReason')),
						reason,
						element(doc, 'button', { type: 'submit' }, t('admin.refund')),
					);
					refund.addEventListener('submit', async (event) => {
						event.preventDefault();
						const minor = fromDecimal(amount.value, payment.currency);
						const answer = await adminCall(api, 'POST', `/v1/admin/payments/${payment.id}/refunds`, {
							amount: minor ?? -1,
							reason: reason.value.trim(),
						});
						if (!answer.ok) {
							note.textContent = fill(t('admin.refundFailed'), { reason: answer.data?.detail ?? '' });
							return;
						}
						refresh(answer.data);
						item.querySelector('.details [role="status"]')?.replaceChildren(t('admin.refundDone'));
					});
					panel.append(refund);
				}
				const actions = element(doc, 'div', { class: 'actions' });
				if (can('bank_transfer') && payment.gateway === 'bank_transfer' && payment.status === 'pending') {
					const confirm = element(doc, 'button', { type: 'button' }, t('admin.confirm'));
					confirm.addEventListener('click', async () => {
						const answer = await adminCall(api, 'POST', `/v1/admin/payments/${payment.id}/confirm`);
						if (!answer.ok) {
							note.textContent = fill(t('admin.confirmFailed'), { reason: answer.data?.detail ?? '' });
							return;
						}
						refresh(answer.data);
						item.querySelector('.details [role="status"]')?.replaceChildren(t('admin.confirmed'));
					});
					actions.append(confirm);
				}
				if (can('bank_transfer') && payment.proof) {
					const proof = element(doc, 'button', { type: 'button', class: 'secondary' }, t('admin.proof'));
					proof.addEventListener('click', async () => {
						const answer = await adminCall(api, 'GET', `/v1/admin/payments/${payment.id}/proof`);
						if (answer.ok) open(answer.data.url);
						else note.textContent = t('admin.failed');
					});
					actions.append(proof);
				}
				const close = element(doc, 'button', { type: 'button', class: 'secondary' }, t('admin.close'));
				close.addEventListener('click', () => panel.remove());
				actions.append(close);
				panel.append(actions, note);
				item.append(panel);
			};

			/**
			 * Fill a list item with a payment's summary.
			 * @param {any} payment @param {HTMLElement} item
			 */
			const row = (payment, item) => {
				const summary = element(
					doc,
					'span',
					{},
					[money(payment.amount, payment.currency), t(`status.${payment.status}`), payment.reference || payment.description]
						.filter(Boolean)
						.join(' · '),
				);
				const meta = element(
					doc,
					'span',
					{ class: 'meta' },
					[
						date(payment.createdAt),
						payment.gateway ? t(`gateway.${payment.gateway}`).replace('{name}', payment.gateway) : '',
						payment.customer?.email ?? '',
						payment.refunded > 0 ? fill(t('admin.refunded'), { amount: money(payment.refunded, payment.currency) }) : '',
						payment.id,
					]
						.filter(Boolean)
						.join(' · '),
				);
				const openButton = element(doc, 'button', { type: 'button', class: 'secondary' }, t('admin.open'));
				openButton.addEventListener('click', async () => {
					const answer = await adminCall(api, 'GET', `/v1/admin/payments/${payment.id}`);
					if (answer.ok) details(answer.data, item);
					else status.textContent = failed(answer);
				});
				const panel = item.querySelector('.details');
				item.replaceChildren(summary, meta, openButton, ...(panel ? [panel] : []));
			};

			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const answer = await adminCall(api, 'GET', query(fresh ? null : cursor));
				if (fresh) list.replaceChildren();
				if (!answer.ok) {
					status.textContent = failed(answer);
					more.setAttribute('hidden', '');
					return;
				}
				cursor = answer.data.nextCursor;
				status.textContent = fresh && answer.data.items.length === 0 ? t('admin.empty') : '';
				for (const payment of answer.data.items) {
					const item = element(doc, 'li');
					row(payment, item);
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
			};

			filters.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			statusFilter.addEventListener('change', () => void load(true));
			more.addEventListener('click', () => void load(false));
			exportButton.addEventListener('click', async () => {
				/** @type {any[]} */
				const rows = [];
				/** @type {string | null} */
				let next = null;
				for (let page = 0; page < EXPORT_PAGES; page += 1) {
					const answer = await adminCall(api, 'GET', query(next).replace(`limit=${PAGE_SIZE}`, 'limit=100'));
					if (!answer.ok) {
						status.textContent = failed(answer);
						return;
					}
					rows.push(...answer.data.items);
					next = answer.data.nextCursor;
					if (!answer.data.hasMore) break;
				}
				save(
					'payments.csv',
					paymentsCsv(rows, {
						id: t('csv.id'),
						date: t('csv.date'),
						status: t('csv.status'),
						amount: t('csv.amount'),
						refunded: t('csv.refunded'),
						gateway: t('csv.gateway'),
						reference: t('csv.reference'),
						email: t('csv.email'),
						description: t('csv.description'),
					}),
				);
			});
			const stop = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				status.textContent = t('admin.signedOut');
			});
			void load(true);
			return () => {
				stop();
			};
		},
	});
};
