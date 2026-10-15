/**
 * The Payment links admin widget (admin widget, ticket; PLAN 0.8.7, 0.6): a list-and-detail screen of the website's
 * payment links, newest first (`links.read`). New link is the main action (a dialog: title, description, a fixed
 * amount or one the payer enters with its minimum, the currency, the gateways it offers, the return address and a
 * reference; `links.manage`). A picked link is read again (its paid count is the latest); the detail shows every field
 * with Copy link as its button, and Open link page, Copy link id and, last, Turn off (or Turn on) in its More menu. Amounts and times follow the website's Format and time zone.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { GATEWAYS, GATEWAY_FEATURES } from '../core/gateways.js';
import { fromDecimal } from '../core/money.js';
import { badge, dot, field, fieldGrid, moreMenu, openDialog, splitView } from './admin-kit.js';
import { element } from './dom.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig,
 *   open: (url: string) => void, copy?: (text: string) => void }} input `open`: open an address in a new tab; `copy`:
 *   put a text on the clipboard
 */
export const mountLinksAdmin = ({ host, api, config, open, copy = () => {} }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const { money, date } = formattersOf(config, host);
	/** @param {any} link */
	const amountOf = (link) =>
		link.amount === null
			? formatText(t('links.anyAmount'), { min: money(link.minAmount ?? 1, link.currency) })
			: money(link.amount, link.currency);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const create = element(doc, 'button', { type: 'button' }, t('links.new'));
			const head = element(doc, 'div', { class: 'head' });
			head.append(element(doc, 'h2', {}, t('links.title')), create);
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('links.more'));
			const view = splitView(doc, t('links.back'));
			view.list.append(list, more);
			const box = element(doc, 'section', { class: 'box' });
			box.append(head, status, view.root);
			root.append(box);
			/** @type {string | null} */
			let cursor = null;
			/** @type {Map<string, any>} */
			const shown = new Map();
			/** @param {any} answer */
			const failed = (answer) => (answer.status === 0 && !api.tickets.current() ? t('links.signedOut') : t('links.failed'));

			/** @param {any} link @param {boolean} [pick] */
			const details = (link, pick = false) => {
				for (const item of list.querySelectorAll('li.item'))
					item.setAttribute('aria-current', String(item.getAttribute('data-id') === link.id));
				const note = element(doc, 'p', { class: 'status', role: 'status' });
				const copyLink = element(doc, 'button', { type: 'button' }, t('links.copy'));
				copyLink.addEventListener('click', () => {
					copy(link.url);
					note.textContent = t('links.copied');
				});
				const switchTo = async (/** @type {boolean} */ active) => {
					const answer = await adminCall(api, 'PATCH', `/v1/admin/links/${link.id}`, { active });
					if (!answer.ok) return formatText(t('links.switchFailed'), { reason: answer.data?.detail ?? '' });
					put(answer.data);
					details(answer.data);
					view.detail.querySelector('[role="status"]')?.replaceChildren(t(active ? 'links.turnedOn' : 'links.turnedOff'));
					return null;
				};
				/** @type {import('./admin-kit.js').MenuItem[]} */
				const menu = [
					{ label: t('links.openPage'), onSelect: () => open(link.url) },
					{ label: t('links.copyId'), onSelect: () => copy(link.id) },
					link.active
						? {
								label: t('links.turnOff'),
								danger: true,
								onSelect: () =>
									openDialog(root, {
										title: t('links.turnOff'),
										body: [element(doc, 'p', {}, formatText(t('links.turnOffIntro'), { title: link.title }))],
										submitLabel: t('links.turnOff'),
										cancelLabel: t('links.close'),
										danger: true,
										onSubmit: () => switchTo(false),
									}),
							}
						: {
								label: t('links.turnOn'),
								onSelect: async () => {
									const error = await switchTo(true);
									if (error) note.textContent = error;
								},
							},
				];
				const actions = element(doc, 'div', { class: 'actions' });
				actions.append(...(link.active ? [copyLink] : []), moreMenu(doc, t('links.moreActions'), menu));
				const heading = element(doc, 'h3', {}, link.title);
				heading.append(badge(doc, t(link.active ? 'links.active' : 'links.off'), link.active ? 'success' : 'neutral'));
				const top = element(doc, 'div', { class: 'head' });
				top.append(heading, actions);
				view.detail.replaceChildren(
					view.back,
					top,
					fieldGrid(doc, [
						[t('links.field.url'), link.url],
						[t('links.field.amount'), amountOf(link)],
						[t('links.field.paid'), String(link.paidCount)],
						[t('links.field.currency'), link.currency],
						[
							t('links.field.gateways'),
							link.gateways.length > 0
								? link.gateways.map((/** @type {string} */ id) => formatText(t(`gateway.${id}`), { name: id })).join(', ')
								: t('links.allGateways'),
						],
						[t('links.field.reference'), link.reference],
						[t('links.field.description'), link.description],
						[t('links.field.returnUrl'), link.returnUrl],
						[t('links.field.created'), date(link.createdAt)],
						[t('links.field.id'), link.id],
					]),
					note,
				);
				if (pick) view.show('detail');
			};

			/** @param {any} link @param {HTMLElement} item */
			const row = (link, item) => {
				item.replaceChildren(
					dot(doc, link.active ? 'success' : 'neutral', t(link.active ? 'links.active' : 'links.off')),
					element(doc, 'span', { class: 'name' }, link.title),
					element(
						doc,
						'span',
						{ class: 'figure' },
						link.amount === null ? link.currency : money(link.amount, link.currency),
					),
					element(
						doc,
						'span',
						{ class: 'meta' },
						[
							t(link.active ? 'links.active' : 'links.off'),
							formatText(t('links.paidCount'), { count: String(link.paidCount) }),
							date(link.createdAt),
						].join(' · '),
					),
				);
			};

			/** Read a picked link again (its paid count is the latest) and show it. @param {string} id */
			const select = async (id) => {
				const answer = await adminCall(api, 'GET', `/v1/admin/links/${id}`);
				if (!answer.ok) {
					status.textContent = failed(answer);
					return;
				}
				put(answer.data);
				details(answer.data, true);
			};

			/** Show a link in the list (a new one first). @param {any} link */
			const put = (link) => {
				shown.set(link.id, link);
				const found = list.querySelector(`li[data-id="${link.id}"]`);
				if (found) return row(link, /** @type {HTMLElement} */ (found));
				const item = element(doc, 'li', { class: 'item', tabindex: '0', 'data-id': link.id });
				row(link, item);
				const pick = () => void select(link.id);
				item.addEventListener('click', pick);
				item.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' || event.key === ' ') pick();
				});
				return item;
			};

			create.addEventListener('click', () => {
				/** @param {string} name @param {Record<string, string>} [extra] */
				const input = (name, extra = {}) => /** @type {HTMLInputElement} */ (element(doc, 'input', { name, ...extra }));
				const title = input('title', { maxlength: '120', required: '' });
				const description = /** @type {HTMLTextAreaElement} */ (
					element(doc, 'textarea', { name: 'description', maxlength: '1000', rows: '3' })
				);
				const currency = input('currency', { maxlength: '3', required: '', autocomplete: 'off' });
				const amount = input('amount', { inputmode: 'decimal' });
				const minimum = input('minAmount', { inputmode: 'decimal' });
				const returnUrl = input('returnUrl', { type: 'url', maxlength: '2048' });
				const reference = input('reference', { maxlength: '120' });
				const choices = GATEWAYS.filter((id) => config.features.includes(GATEWAY_FEATURES[id]));
				const gateways = element(doc, 'fieldset', { class: 'wide' });
				gateways.append(element(doc, 'legend', {}, t('links.field.gateways')));
				for (const id of choices) {
					const box = /** @type {HTMLInputElement} */ (
						element(doc, 'input', { type: 'checkbox', name: 'gateway', value: id })
					);
					const label = element(doc, 'label', { class: 'check' });
					label.append(box, formatText(t(`gateway.${id}`), { name: id }));
					gateways.append(label);
				}
				const grid = element(doc, 'div', { class: 'grid' });
				const wide = (/** @type {HTMLElement} */ node) => {
					node.classList.add('wide');
					return node;
				};
				grid.append(
					wide(field(doc, t('links.field.title'), title)),
					field(doc, t('links.field.currency'), currency),
					field(doc, t('links.field.fixedAmount'), amount),
					field(doc, t('links.field.minimum'), minimum),
					field(doc, t('links.field.reference'), reference),
					wide(field(doc, t('links.field.returnUrl'), returnUrl)),
					wide(field(doc, t('links.field.description'), description)),
					gateways,
				);
				openDialog(root, {
					title: t('links.new'),
					body: [element(doc, 'p', { class: 'meta' }, t('links.newHelp')), grid],
					submitLabel: t('links.create'),
					cancelLabel: t('links.close'),
					onSubmit: async () => {
						const code = currency.value.trim().toUpperCase();
						const fixed = amount.value.trim() ? fromDecimal(amount.value, code) : null;
						const min = minimum.value.trim() ? fromDecimal(minimum.value, code) : null;
						if ((amount.value.trim() && fixed === null) || (minimum.value.trim() && min === null))
							return t('links.invalidAmount');
						const picked = [...gateways.querySelectorAll('input:checked')].map(
							(box) => /** @type {HTMLInputElement} */ (box).value,
						);
						const answer = await adminCall(api, 'POST', '/v1/admin/links', {
							title: title.value.trim(),
							description: description.value.trim(),
							currency: code,
							amount: fixed,
							...(fixed === null && min !== null ? { minAmount: min } : {}),
							gateways: picked,
							...(returnUrl.value.trim() ? { returnUrl: returnUrl.value.trim() } : {}),
							reference: reference.value.trim(),
						});
						if (!answer.ok) return formatText(t('links.createFailed'), { reason: answer.data?.detail ?? '' });
						const item = put(answer.data);
						if (item) list.prepend(item);
						status.textContent = '';
						details(answer.data, true);
						view.detail.querySelector('[role="status"]')?.replaceChildren(t('links.created'));
						return null;
					},
				});
			});

			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const params = new URLSearchParams({ limit: '25' });
				if (!fresh && cursor) params.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/links?${params.toString()}`);
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
				status.textContent = fresh && answer.data.items.length === 0 ? t('links.empty') : '';
				for (const link of answer.data.items) {
					const item = put(link);
					if (item) list.append(item);
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
			more.addEventListener('click', () => void load(false));
			const stop = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				view.detail.replaceChildren();
				status.textContent = t('links.signedOut');
			});
			void load(true);
			return () => {
				stop();
			};
		},
	});
};
