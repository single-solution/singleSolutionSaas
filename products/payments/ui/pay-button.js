/**
 * The pay button (visitor widget, browser token; PLAN 0.8.7). Placed with `data-link="link_…"` it shows the payment
 * link (title, amount or an amount field, the payer's name and email, the payment method) and makes the payment;
 * placed with `data-payment="pay_…"` it shows a payment the merchant's server created. Either way the payer then goes
 * to the pay page, and from there to the gateway's own page: card details are never asked here. Amounts follow the
 * website's Format. It renders nothing when the link or payment cannot be shown (feature off, product stopped, unknown
 * id).
 * @module
 */
import { element, formatText, mountWidget } from '@ss/app-kit/widget';
import { toDecimal } from '../core/payments.js';
import { formattersOf } from './format.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */
/** @typedef {(path: string, init?: { method?: string, body?: unknown }) => Promise<{ ok: boolean, status: number, data: any }>} VisitorCall */

/**
 * @param {{ host: HTMLElement, config: WidgetConfig, call: VisitorCall, go: (url: string) => void }} input `go`: send
 *   the payer's browser to an address
 * @returns {Promise<void>}
 */
export const mountPayButton = async ({ host, config, call, go }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const linkId = host.dataset.link ?? '';
	const paymentId = host.dataset.payment ?? '';
	const path = /^link_[A-Za-z0-9]+$/.test(linkId)
		? `/v1/checkout/links/${linkId}`
		: /^pay_[A-Za-z0-9]+$/.test(paymentId)
			? `/v1/checkout/payments/${paymentId}`
			: null;
	if (path === null) return;
	const answer = await call(path);
	if (!answer.ok) return;
	const data = answer.data;
	const { money, amountOf } = formattersOf(config, host);
	mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			const box = element(doc, 'form', { class: 'box' });
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			if (path.startsWith('/v1/checkout/payments/')) {
				const amount = money(data.amount, data.currency);
				if (data.description) box.append(element(doc, 'h2', {}, data.description));
				if (['paid', 'partially_refunded', 'refunded'].includes(data.status))
					box.append(element(doc, 'p', { class: 'amount' }, `${amount} · ${t('button.paid')}`));
				// the merchant canceled it: no Pay button (K-13)
				else if (data.status === 'voided')
					box.append(element(doc, 'p', { class: 'amount' }, `${amount} · ${t('button.voided')}`));
				else {
					box.append(element(doc, 'button', { type: 'submit' }, formatText(t('button.pay'), { amount })));
					box.addEventListener('submit', (event) => {
						event.preventDefault();
						go(data.checkoutUrl);
					});
				}
				root.append(box);
				return;
			}
			box.append(element(doc, 'h2', {}, data.title));
			if (data.description) box.append(element(doc, 'p', {}, data.description));
			/** @type {HTMLInputElement | null} */
			let amountInput = null;
			if (data.amount === null) {
				box.append(
					element(doc, 'label', { for: 'ss-pay-amount' }, formatText(t('link.amount'), { currency: data.currency })),
				);
				amountInput = /** @type {HTMLInputElement} */ (
					element(doc, 'input', { id: 'ss-pay-amount', inputmode: 'decimal', required: '' })
				);
				box.append(
					amountInput,
					element(
						doc,
						'span',
						{ class: 'meta' },
						formatText(t('link.amountHelp'), { min: money(data.minAmount, data.currency) }),
					),
				);
			} else box.append(element(doc, 'p', { class: 'amount' }, money(data.amount, data.currency)));
			const name = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { id: 'ss-pay-name', autocomplete: 'name', maxlength: '120' })
			);
			const email = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { id: 'ss-pay-email', type: 'email', autocomplete: 'email', maxlength: '254' })
			);
			// what the link asks beyond the amount (P3): the phone, and the merchant's own questions
			const phone =
				data.phone !== 'optional' && data.phone !== 'required'
					? null
					: /** @type {HTMLInputElement} */ (
							element(doc, 'input', {
								id: 'ss-pay-phone',
								type: 'tel',
								autocomplete: 'tel',
								maxlength: '20',
								...(data.phone === 'required' ? { required: '' } : {}),
							})
						);
			/** @type {Array<{ label: string, required: boolean }>} */
			const questions = data.fields ?? [];
			const answers = questions.map(
				(question, index) =>
					/** @type {HTMLInputElement} */ (
						element(doc, 'input', {
							id: `ss-pay-field-${index}`,
							maxlength: '200',
							...(question.required ? { required: '' } : {}),
						})
					),
			);
			const method = /** @type {HTMLSelectElement} */ (element(doc, 'select', { id: 'ss-pay-method' }));
			method.append(
				...data.gateways.map((/** @type {{ id: string, name: string }} */ g) =>
					element(doc, 'option', { value: g.id }, g.name),
				),
			);
			const button = element(doc, 'button', { type: 'submit' }, t('link.pay'));
			box.append(
				element(doc, 'label', { for: 'ss-pay-name' }, t('link.name')),
				name,
				element(doc, 'label', { for: 'ss-pay-email' }, t('link.email')),
				email,
				...(phone
					? [
							element(
								doc,
								'label',
								{ for: 'ss-pay-phone' },
								t(data.phone === 'required' ? 'link.phone' : 'link.phoneOptional'),
							),
							phone,
						]
					: []),
				...questions.flatMap((question, index) => [
					element(doc, 'label', { for: `ss-pay-field-${index}` }, question.label),
					/** @type {HTMLInputElement} */ (answers[index]),
				]),
				element(doc, 'label', { for: 'ss-pay-method' }, t('link.method')),
				method,
				button,
				status,
			);
			if (data.gateways.length === 0) {
				button.setAttribute('disabled', '');
				status.textContent = t('page.noGateway');
			}
			const invalidAmount = () => formatText(t('link.invalidAmount'), { min: money(data.minAmount ?? 1, data.currency) });
			box.addEventListener('submit', async (event) => {
				event.preventDefault();
				// typed with the decimal sign money is shown with (P6); the API takes a plain decimal
				const typed = amountInput ? amountOf(amountInput.value, data.currency) : null;
				if (amountInput && typed === null) {
					status.textContent = invalidAmount();
					return;
				}
				button.setAttribute('disabled', '');
				status.textContent = '';
				const made = await call(path, {
					method: 'POST',
					body: {
						...(typed === null ? {} : { amount: toDecimal(typed, data.currency) }),
						gateway: method.value,
						customer: {
							name: name.value.trim(),
							email: email.value.trim(),
							...(phone ? { phone: phone.value.trim() } : {}),
						},
						...(answers.length > 0 ? { answers: answers.map((answer) => answer.value.trim()) } : {}),
					},
				});
				button.removeAttribute('disabled');
				if (made.ok) return go(made.data.checkoutUrl);
				const field = String(made.data?.errors?.[0]?.path ?? '');
				const question = /^\/answers\/(\d+)$/.exec(field);
				status.textContent =
					field === '/amount'
						? invalidAmount()
						: field === '/email'
							? t('link.invalidEmail')
							: field === '/phone'
								? t('link.invalidPhone')
								: question
									? formatText(t('link.invalidAnswer'), { label: questions[Number(question[1])]?.label ?? '' })
									: field === '/gateway'
										? t('link.invalidMethod')
										: t('button.failed');
			});
			root.append(box);
		},
	});
};
