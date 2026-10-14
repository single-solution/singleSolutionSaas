/**
 * The Payments admin widget (admin widget, ticket; PLAN 0.8.7, 0.6): a list-and-detail screen of the website's
 * payments, newest first. The list has search by id, reference or email, a status filter with each status's count,
 * the total as a badge, the counts per gateway, paging and a CSV export of the payments that match the filters (at most
 * 2,000). The detail shows every field of the payment, its refunds and history, with Refund (full or partial,
 * `payments.refund`) and Confirm transfer received (with the transfer's reference and a note, `payments.confirm`, PLAN
 * 0.8.10 P3; also for a transfer that arrives after the payment was canceled) as buttons, a Refund due mark on money
 * that arrived after the merchant canceled the payment (K-13), and View proof, Copy pay link, Open pay page and Copy payment id in its More menu; forms open
 * in dialogs. Amounts and times follow the website's Format and time zone; the CSV keeps the stored times and the
 * amounts with their currency codes.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { fromDecimal, toDecimal } from '../core/money.js';
import { PAYMENT_STATUSES, paymentsCsv } from '../core/payments.js';
import { badge, dot, field, fieldGrid, fill, listSection, moreMenu, openDialog, splitView } from './admin-kit.js';
import { element } from './dom.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** Rows fetched per page, and pages an export reads at most. */
const PAGE_SIZE = 25;
const EXPORT_PAGES = 20;

/** The tone of each payment status. @type {Record<string, import('./admin-kit.js').Tone>} */
const TONES = {
	pending: 'warning',
	paid: 'success',
	failed: 'danger',
	cancelled: 'neutral',
	voided: 'neutral',
	partially_refunded: 'warning',
};

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig,
 *   save: (name: string, text: string) => void, open: (url: string) => void, copy?: (text: string) => void }} input
 *   `save`: hand a file to the browser; `open`: open an address in a new tab; `copy`: put a text on the clipboard
 */
export const mountPaymentsAdmin = ({ host, api, config, save, open, copy = () => {} }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const can = (/** @type {string} */ feature) => config.features.includes(feature);
	const { money, date } = formattersOf(config, host);
	/** @param {string | null} gateway */
	const gatewayName = (gateway) => (gateway ? fill(t(`gateway.${gateway}`), { name: gateway }) : '');
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const search = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { type: 'search', 'aria-label': t('admin.search'), placeholder: t('admin.search') })
			);
			const statusFilter = /** @type {HTMLSelectElement} */ (element(doc, 'select', { 'aria-label': t('admin.status') }));
			/** @param {Record<string, number> | null} groups @param {number | null} total */
			const statusOptions = (groups, total) => {
				const picked = statusFilter.value;
				/** @param {string} text @param {number | null | undefined} count */
				const label = (text, count) => (typeof count === 'number' ? `${text} (${count})` : text);
				statusFilter.replaceChildren(
					element(doc, 'option', { value: '' }, label(t('admin.all'), total)),
					...PAYMENT_STATUSES.map((value) =>
						element(doc, 'option', { value }, label(t(`status.${value}`), groups ? (groups[value] ?? 0) : null)),
					),
				);
				statusFilter.value = picked;
			};
			statusOptions(null, null);
			const searchButton = element(doc, 'button', { type: 'submit', class: 'secondary' }, t('admin.searchButton'));
			const exportButton = element(doc, 'button', { type: 'button', class: 'secondary' }, t('admin.export'));
			const filters = element(doc, 'form', { class: 'row' });
			filters.append(search, statusFilter, searchButton);
			const total = element(doc, 'span', { class: 'badge neutral', hidden: '' });
			const title = element(doc, 'h2', {}, t('admin.title'));
			title.append(total);
			const head = element(doc, 'div', { class: 'head' });
			head.append(title, exportButton);
			const byGateway = element(doc, 'p', { class: 'meta', hidden: '' });
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('admin.more'));
			const view = splitView(doc, t('admin.back'));
			view.list.append(list, more);
			const box = element(doc, 'section', { class: 'box' });
			box.append(head, filters, byGateway, status, view.root);
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
			/** @param {any} answer @param {string} key */
			const reasonOf = (answer, key) => fill(t(key), { reason: answer.data?.detail ?? '' });

			/** The counts of the payments the search matches: per status (in the filter), per gateway and in all. */
			const loadCounts = async () => {
				const params = new URLSearchParams();
				if (search.value.trim()) params.set('q', search.value.trim());
				const [states, gateways] = await Promise.all([
					adminCall(api, 'GET', `/v1/admin/payments/counts?${new URLSearchParams([...params, ['by', 'state']])}`),
					adminCall(api, 'GET', `/v1/admin/payments/counts?${new URLSearchParams([...params, ['by', 'gateway']])}`),
				]);
				if (states.ok) {
					statusOptions(states.data.groups, states.data.total);
					total.textContent = String(states.data.total);
					total.removeAttribute('hidden');
				}
				const parts = gateways.ok
					? Object.entries(/** @type {Record<string, number>} */ (gateways.data.groups))
							.filter(([gateway]) => gateway !== 'none')
							.map(([gateway, count]) => `${gatewayName(gateway)} ${count}`)
					: [];
				byGateway.textContent = parts.join(' · ');
				if (parts.length > 0) byGateway.removeAttribute('hidden');
				else byGateway.setAttribute('hidden', '');
			};

			/**
			 * The selected payment: every field, refunds and history, its actions.
			 * @param {any} payment
			 */
			const details = (payment) => {
				for (const item of list.querySelectorAll('li.item'))
					item.setAttribute('aria-current', String(item.getAttribute('data-id') === payment.id));
				const note = element(doc, 'p', { class: 'status', role: 'status' });
				/** @param {any} next @param {string} done */
				const refresh = (next, done) => {
					const item = list.querySelector(`li[data-id="${next.id}"]`);
					if (item) row(next, /** @type {HTMLElement} */ (item));
					details(next);
					view.detail.querySelector('[role="status"]')?.replaceChildren(done);
					void loadCounts();
				};
				const left = payment.amount - payment.refunded;
				/** @type {HTMLElement[]} */
				const buttons = [];
				if (can('refunds') && (payment.status === 'paid' || payment.status === 'partially_refunded') && left > 0) {
					const refund = element(doc, 'button', { type: 'button' }, t('admin.refund'));
					refund.addEventListener('click', () => {
						const amount = /** @type {HTMLInputElement} */ (
							element(doc, 'input', { inputmode: 'decimal', name: 'amount' })
						);
						amount.value = toDecimal(left, payment.currency);
						const reason = /** @type {HTMLInputElement} */ (element(doc, 'input', { name: 'reason', maxlength: '200' }));
						openDialog(root, {
							title: t('admin.refund'),
							body: [
								field(doc, fill(t('admin.refundAmount'), { currency: payment.currency }), amount),
								field(doc, t('admin.refundReason'), reason),
							],
							submitLabel: t('admin.refund'),
							cancelLabel: t('admin.close'),
							onSubmit: async () => {
								const minor = fromDecimal(amount.value, payment.currency);
								const answer = await adminCall(api, 'POST', `/v1/admin/payments/${payment.id}/refunds`, {
									amount: minor ?? -1,
									reason: reason.value.trim(),
								});
								if (!answer.ok) return reasonOf(answer, 'admin.refundFailed');
								refresh(answer.data, t('admin.refundDone'));
								return null;
							},
						});
					});
					buttons.push(refund);
				}
				// a transfer that arrives after the payment was canceled is confirmed too, and is then to be refunded
				if (
					can('bank_transfer') &&
					payment.gateway === 'bank_transfer' &&
					(payment.status === 'pending' || payment.status === 'voided')
				) {
					const confirm = element(doc, 'button', { type: 'button' }, t('admin.confirm'));
					confirm.addEventListener('click', () => {
						// the transfer's reference and a note go with the confirmation (PLAN 0.8.10 P3)
						const reference = /** @type {HTMLInputElement} */ (
							element(doc, 'input', { name: 'reference', maxlength: '120', autocomplete: 'off' })
						);
						const remark = /** @type {HTMLTextAreaElement} */ (
							element(doc, 'textarea', { name: 'note', maxlength: '500', rows: '3' })
						);
						openDialog(root, {
							title: t('admin.confirm'),
							body: [
								element(doc, 'p', {}, fill(t('admin.confirmIntro'), { amount: money(payment.amount, payment.currency) })),
								field(doc, t('admin.confirmReference'), reference),
								field(doc, t('admin.confirmNote'), remark),
							],
							submitLabel: t('admin.confirm'),
							cancelLabel: t('admin.close'),
							onSubmit: async () => {
								const answer = await adminCall(api, 'POST', `/v1/admin/payments/${payment.id}/confirm`, {
									reference: reference.value.trim(),
									note: remark.value.trim(),
								});
								if (!answer.ok) return reasonOf(answer, 'admin.confirmFailed');
								refresh(answer.data, t('admin.confirmed'));
								return null;
							},
						});
					});
					buttons.push(confirm);
				}
				/** @type {import('./admin-kit.js').MenuItem[]} */
				const menu = [];
				if (can('bank_transfer') && payment.proof)
					menu.push({
						label: t('admin.proof'),
						onSelect: async () => {
							const answer = await adminCall(api, 'GET', `/v1/admin/payments/${payment.id}/proof`);
							if (answer.ok) open(answer.data.url);
							else note.textContent = failed(answer);
						},
					});
				if (payment.checkoutUrl && ['pending', 'failed', 'cancelled'].includes(payment.status))
					menu.push(
						{ label: t('admin.copyPayLink'), onSelect: () => copy(payment.checkoutUrl) },
						{ label: t('admin.openPayPage'), onSelect: () => open(payment.checkoutUrl) },
					);
				menu.push({ label: t('admin.copyId'), onSelect: () => copy(payment.id) });
				const actions = element(doc, 'div', { class: 'actions' });
				actions.append(...buttons, moreMenu(doc, t('admin.moreActions'), menu));
				const heading = element(doc, 'h3', {}, money(payment.amount, payment.currency));
				heading.append(badge(doc, t(`status.${payment.status}`), TONES[payment.status]));
				if (payment.refundDue) heading.append(badge(doc, t('admin.refundDue'), 'danger'));
				const top = element(doc, 'div', { class: 'head' });
				top.append(heading, actions);
				const customer = payment.customer ?? {};
				const proof = payment.proof
					? [payment.proof.type, `${Math.max(1, Math.round(payment.proof.size / 1024))} kB`, date(payment.proof.uploadedAt)]
							.filter(Boolean)
							.join(' · ')
					: '';
				const fields = fieldGrid(doc, [
					[t('admin.field.gateway'), gatewayName(payment.gateway)],
					[t('admin.field.reference'), payment.reference],
					[t('admin.field.description'), payment.description],
					[t('admin.field.name'), customer.name],
					[t('admin.field.email'), customer.email],
					[t('admin.field.phone'), customer.phone],
					[t('admin.field.customerId'), customer.id],
					[t('admin.field.refunded'), payment.refunded > 0 ? money(payment.refunded, payment.currency) : ''],
					[t('admin.field.gatewayReference'), payment.gatewayReference],
					[t('admin.field.source'), payment.source ? t(`admin.source.${payment.source}`) : ''],
					[t('admin.field.link'), payment.linkId],
					[t('admin.field.proof'), proof],
					[t('admin.field.created'), date(payment.createdAt)],
					[t('admin.field.paid'), payment.paidAt ? date(payment.paidAt) : ''],
					[t('admin.field.voided'), payment.voidedAt ? date(payment.voidedAt) : ''],
					[t('admin.field.updated'), payment.updatedAt ? date(payment.updatedAt) : ''],
					[t('admin.field.id'), payment.id],
					...Object.entries(/** @type {Record<string, string>} */ (payment.metadata ?? {})).map(
						([name, value]) => /** @type {[string, string]} */ ([name, value]),
					),
				]);
				const sections = [
					listSection(
						doc,
						t('admin.refunds'),
						(payment.refunds ?? []).map((/** @type {any} */ refund) =>
							[
								date(refund.createdAt),
								money(refund.amount, payment.currency),
								refund.reason,
								refund.by,
								refund.manual ? t('admin.manual') : '',
							]
								.filter(Boolean)
								.join(' · '),
						),
					),
					listSection(
						doc,
						t('admin.history'),
						payment.history.map((/** @type {any} */ entry) =>
							[date(entry.at), entry.event, entry.detail ?? '', entry.by ?? '', entry.reference ?? '', entry.note ?? '']
								.filter(Boolean)
								.join(' · '),
						),
					),
				];
				view.detail.replaceChildren(view.back, top, fields, ...sections.filter((node) => node !== null), note);
			};

			/** @param {string} id @param {boolean} pick the user picked it (a narrow widget shows it alone) */
			const select = async (id, pick) => {
				const answer = await adminCall(api, 'GET', `/v1/admin/payments/${id}`);
				if (!answer.ok) {
					status.textContent = failed(answer);
					return;
				}
				details(answer.data);
				if (pick) view.show('detail');
			};

			/**
			 * Fill a list row with a payment's summary: a status dot, its name and its amount.
			 * @param {any} payment @param {HTMLElement} item
			 */
			const row = (payment, item) => {
				const meta = element(
					doc,
					'span',
					{ class: 'meta' },
					[
						t(`status.${payment.status}`),
						payment.refundDue ? t('admin.refundDue') : '',
						date(payment.createdAt),
						gatewayName(payment.gateway),
						payment.customer?.email ?? '',
						payment.refunded > 0 ? fill(t('admin.refunded'), { amount: money(payment.refunded, payment.currency) }) : '',
					]
						.filter(Boolean)
						.join(' · '),
				);
				item.replaceChildren(
					dot(doc, TONES[payment.status] ?? 'neutral', t(`status.${payment.status}`)),
					element(doc, 'span', { class: 'name' }, payment.reference || payment.description || payment.id),
					element(doc, 'span', { class: 'figure' }, money(payment.amount, payment.currency)),
					meta,
				);
			};

			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const answer = await adminCall(api, 'GET', query(fresh ? null : cursor));
				if (fresh) {
					list.replaceChildren();
					void loadCounts();
				}
				if (!answer.ok) {
					status.textContent = failed(answer);
					more.setAttribute('hidden', '');
					return;
				}
				cursor = answer.data.nextCursor;
				status.textContent = fresh && answer.data.items.length === 0 ? t('admin.empty') : '';
				for (const payment of answer.data.items) {
					const item = element(doc, 'li', { class: 'item', tabindex: '0', 'data-id': payment.id });
					row(payment, item);
					item.addEventListener('click', () => void select(payment.id, true));
					item.addEventListener('keydown', (event) => {
						if (event.key === 'Enter' || event.key === ' ') void select(payment.id, true);
					});
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
				// a wide widget is never half empty: the first payment shows until another is picked (PLAN 0.6)
				if (fresh) {
					view.show('list');
					const first = answer.data.items[0];
					if (first) await select(first.id, false);
					else view.detail.replaceChildren();
				}
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
				view.detail.replaceChildren();
				status.textContent = t('admin.signedOut');
			});
			void load(true);
			return () => {
				stop();
			};
		},
	});
};
