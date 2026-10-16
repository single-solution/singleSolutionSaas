/**
 * The Payment links admin widget (admin widget, ticket; PLAN 0.8.7, 0.6): a list-and-detail screen of the website's
 * payment links, newest first (`links.read`). New link is the main action (a dialog: title, description, a fixed
 * amount or one the payer enters with its minimum, the currency (an ISO 4217 picker that starts with the newest link's), the gateways it offers, the return address and a
 * reference; `links.manage`). A picked link is read again (its paid count is the latest); the detail shows every field
 * with Copy link as its button, and Open link page, Copy link id and, last, Turn off (or Turn on) in its More menu. Amounts and times follow the website's Format and time zone.
 * @module
 */
import {
	adminCall,
	badge,
	block,
	dot,
	element,
	fieldGrid,
	formatText,
	moreMenu,
	mountWidget,
	openDialog,
	checkGroup,
	segmented,
	splitView,
	stateSlot,
	toggle,
} from '@ss/app-kit/widget';
import { GATEWAYS, GATEWAY_CURRENCIES, GATEWAY_FEATURES } from '../core/gateways.js';
import { field } from './admin-kit.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';

/**
 * The ISO 4217 currencies the browser knows, each as `code · name` in US English (the admin's language), for the
 * currency picker (P7).
 * @param {string} [also] a code to keep in the list even when the browser does not know it
 * @returns {Array<[string, string]>}
 */
const currencyChoices = (also = '') => {
	const codes = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
	const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en-US'], { type: 'currency' }) : null;
	const all = also && !codes.includes(also) ? [...codes, also].sort() : codes;
	return all.map((code) => {
		const name = names?.of(code);
		return [code, name && name !== code ? `${code} · ${name}` : code];
	});
};

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig,
 *   open: (url: string) => void, copy?: (text: string) => void }} input `open`: open an address in a new tab; `copy`:
 *   put a text on the clipboard
 */
export const mountLinksAdmin = ({ host, api, config, open, copy = () => {} }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const { money, date, amountOf: typedAmount, amountText } = formattersOf(config, host);
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
			const state = stateSlot(doc);
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('links.more'));
			const view = splitView(doc, t('links.back'));
			view.list.append(list, more);
			const box = element(doc, 'section', { class: 'box admin' });
			const tools = block(doc, { body: [head, status, state.root] });
			tools.classList.add('tools');
			box.append(tools, view.root);
			root.append(box);
			/** @type {string | null} */
			let cursor = null;
			/** @type {Map<string, any>} */
			const shown = new Map();
			// a new link starts in the currency of the newest one (the store currency is not known yet, P7)
			let lastCurrency = '';
			/** @param {any} answer */
			const failed = (answer) => (answer.status === 0 && !api.tickets.current() ? t('links.signedOut') : t('links.failed'));
			/**
			 * The merchant's manual payment methods (fixed-choices P1): offered next to the gateways, and named by their own
			 * names; read once, when the widget opens.
			 * @type {Promise<Array<{ key: string, name: string }>>}
			 */
			const manual = config.features.includes('manual_payments')
				? adminCall(api, 'GET', '/v1/admin/manual-methods').then((answer) => (answer.ok ? answer.data.methods : []))
				: Promise.resolve([]);
			/** @type {Map<string, string>} */
			const manualNames = new Map();
			void manual.then((methods) => {
				for (const method of methods) manualNames.set(method.key, method.name);
			});
			/** Whether a link takes payments: off, ended by itself (its date, its payments; P3), or active. @param {any} link */
			const stateOf = (link) =>
				!link.active ? t('links.off') : link.closed ? t(`links.closed.${link.closed}`) : t('links.active');
			/** A gateway's or a manual method's name. @param {string} id */
			const nameOf = (id) => manualNames.get(id) ?? formatText(t(`gateway.${id}`), { name: id });

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
				/** @type {import('@ss/app-kit/widget').MenuItem[]} */
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
										closeLabel: t('links.close'),
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
				heading.append(badge(doc, stateOf(link), link.active && !link.closed ? 'success' : 'neutral'));
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
								? link.gateways.map((/** @type {string} */ id) => nameOf(id)).join(', ')
								: t('links.allGateways'),
						],
						[t('links.field.reference'), link.reference],
						[t('links.field.phone'), t(`links.phone.${link.phone}`)],
						[
							t('links.field.questions'),
							link.fields.map((/** @type {{ label: string, required: boolean }} */ question) => question.label).join(', '),
						],
						[t('links.field.expiresAt'), link.expiresAt ? date(link.expiresAt) : ''],
						[t('links.field.maxPayments'), link.maxPayments === null ? '' : String(link.maxPayments)],
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
					dot(doc, link.active && !link.closed ? 'success' : 'neutral', stateOf(link)),
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
						[stateOf(link), formatText(t('links.paidCount'), { count: String(link.paidCount) }), date(link.createdAt)].join(
							' · ',
						),
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

			create.addEventListener('click', async () => {
				const methods = await manual;
				/** @param {string} name @param {Record<string, string>} [extra] */
				const input = (name, extra = {}) => /** @type {HTMLInputElement} */ (element(doc, 'input', { name, ...extra }));
				const title = input('title', { maxlength: '120', required: '' });
				const description = /** @type {HTMLTextAreaElement} */ (
					element(doc, 'textarea', { name: 'description', maxlength: '1000', rows: '3' })
				);
				const currency = /** @type {HTMLSelectElement} */ (element(doc, 'select', { name: 'currency', required: '' }));
				currency.append(
					element(doc, 'option', { value: '' }, t('links.pickCurrency')),
					...currencyChoices(lastCurrency).map(([code, label]) => element(doc, 'option', { value: code }, label)),
				);
				currency.value = lastCurrency;
				const amount = input('amount', { inputmode: 'decimal' });
				const minimum = input('minAmount', { inputmode: 'decimal' });
				const returnUrl = input('returnUrl', { type: 'url', maxlength: '2048' });
				const reference = input('reference', { maxlength: '120' });
				const choices = GATEWAYS.filter((id) => config.features.includes(GATEWAY_FEATURES[id]));
				const names = choices.map((id) => formatText(t(`gateway.${id}`), { name: id }));
				const gateways = element(doc, 'fieldset', { class: 'wide' });
				gateways.append(element(doc, 'legend', {}, t('links.field.gateways')));
				/** @type {Array<[string, string]>} */
				const offered = [
					...choices.map((id, index) => {
						// payers see a gateway's brand only (P10): two with the same brand are told apart by their currencies
						const name = /** @type {string} */ (names[index]);
						const currencies = GATEWAY_CURRENCIES[id];
						const twin = names.filter((other) => other === name).length > 1 && currencies !== null;
						return /** @type {[string, string]} */ ([id, twin ? `${name} (${currencies.join(', ')})` : name]);
					}),
					...methods.map((method) => /** @type {[string, string]} */ ([method.key, method.name])),
				];
				gateways.append(
					checkGroup(doc, {
						label: t('links.field.gateways'),
						name: 'gateway',
						items: offered.map(([value, label]) => ({ value, label })),
						look: 'card',
					}).node,
				);
				// what the link asks beyond the amount, and when it ends by itself (P3)
				const phone = segmented(doc, {
					label: t('links.field.phone'),
					name: 'phone',
					items: ['off', 'optional', 'required'].map((value) => ({ value, label: t(`links.phone.${value}`) })),
					value: 'off',
				});
				const questions = [0, 1, 2].map((index) => ({
					label: input(`field_${index}`, { maxlength: '60' }),
					required: toggle(doc, formatText(t('links.field.questionRequired'), { n: index + 1 }), {
						inline: true,
						name: `field_${index}_required`,
					}),
				}));
				const asked = element(doc, 'fieldset', { class: 'wide' });
				asked.append(element(doc, 'legend', {}, t('links.field.questions')));
				questions.forEach((question, index) => {
					asked.append(
						field(doc, formatText(t('links.field.question'), { n: index + 1 }), question.label),
						question.required.node,
					);
				});
				const expiresAt = input('expiresAt', { type: 'datetime-local' });
				const maxPayments = input('maxPayments', { type: 'number', min: '1', step: '1', inputmode: 'numeric' });
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
					field(doc, t('links.field.phone'), phone.node),
					asked,
					field(doc, t('links.field.expiresAt'), expiresAt),
					field(doc, t('links.field.maxPayments'), maxPayments),
				);
				openDialog(root, {
					title: t('links.new'),
					body: [element(doc, 'p', { class: 'meta' }, t('links.newHelp')), grid],
					submitLabel: t('links.create'),
					closeLabel: t('links.close'),
					onSubmit: async () => {
						const code = currency.value;
						// amounts are typed with the decimal sign money is shown with (P6)
						const fixed = amount.value.trim() ? typedAmount(amount.value, code) : null;
						const min = minimum.value.trim() ? typedAmount(minimum.value, code) : null;
						if ((amount.value.trim() && fixed === null) || (minimum.value.trim() && min === null))
							return formatText(t('links.invalidAmount'), { example: amountText(250050, 'USD') });
						const picked = [...gateways.querySelectorAll('input:checked')].map(
							(box) => /** @type {HTMLInputElement} */ (box).value,
						);
						// the end date in the viewer's own time, sent as an ISO time; a whole number of payments from 1
						const ends = expiresAt.value ? new Date(expiresAt.value) : null;
						const most = maxPayments.value.trim() ? Number(maxPayments.value) : null;
						if (
							(ends !== null && (Number.isNaN(ends.getTime()) || ends.getTime() <= Date.now())) ||
							(most !== null && (!Number.isSafeInteger(most) || most < 1))
						)
							return t('links.invalidEnds');
						const answer = await adminCall(api, 'POST', '/v1/admin/links', {
							title: title.value.trim(),
							description: description.value.trim(),
							currency: code,
							amount: fixed,
							...(fixed === null && min !== null ? { minAmount: min } : {}),
							gateways: picked,
							...(returnUrl.value.trim() ? { returnUrl: returnUrl.value.trim() } : {}),
							reference: reference.value.trim(),
							phone: phone.value,
							fields: questions
								.filter((question) => question.label.value.trim() !== '')
								.map((question) => ({ label: question.label.value.trim(), required: question.required.box.checked })),
							expiresAt: ends ? ends.toISOString() : null,
							maxPayments: most,
						});
						if (!answer.ok) return formatText(t('links.createFailed'), { reason: answer.data?.detail ?? '' });
						lastCurrency = answer.data.currency;
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
				await manual;
				const params = new URLSearchParams({ limit: '25' });
				if (!fresh && cursor) params.set('cursor', cursor);
				status.textContent = '';
				if (list.childElementCount === 0) state.loading(t('admin.loading'));
				const answer = await adminCall(api, 'GET', `/v1/admin/links?${params.toString()}`);
				if (fresh) {
					list.replaceChildren();
					shown.clear();
				}
				if (!answer.ok) {
					state.failed(
						failed(answer),
						api.tickets.current() ? { label: t('admin.tryAgain'), onRetry: () => load(fresh) } : undefined,
					);
					more.setAttribute('hidden', '');
					return;
				}
				cursor = answer.data.nextCursor;
				if (fresh) lastCurrency = answer.data.items[0]?.currency ?? '';
				if (fresh && answer.data.items.length === 0) {
					// the next step: the same New link button as in the heading
					const first = element(doc, 'button', { type: 'button' }, t('links.new'));
					first.addEventListener('click', () => create.click());
					state.empty(t('links.empty'), first);
				} else state.clear();
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
