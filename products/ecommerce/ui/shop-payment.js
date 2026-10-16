/**
 * Paying first in the shopper widgets (E24, E8): what a method paid first tells shoppers — its instructions and its
 * accounts, each the merchant's own label/value rows (the method's own, or those of Payments' manual method of the same
 * key) —, the merchant's note for the payment method, and, while an order waits for a payment staff record
 * (`canSendProof`), the proof of payment: the file goes straight to the merchant's storage with a signed address
 * (`POST /v1/shop/orders/:id/proof/upload`), then `POST /v1/shop/orders/:id/proof` sends it with the shopper's
 * reference. The cart shows the details before the order is placed; its success page and My orders show the details,
 * the proof sent and the proof form.
 * @module
 */
import { PROOF_MAX_BYTES, PROOF_TYPES } from '../core/orders.js';
import { field, formatsOf, h, problemText } from './shop-common.js';
import { codeOf } from './problem-code.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** @param {unknown} value */
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
/** @param {unknown} value @returns {any[]} */
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * The box of what a method paid first tells shoppers: each account (its name, then its rows with a value), then the
 * instructions; null when there is nothing to show.
 * @param {Document} doc
 * @param {Texts} t
 * @param {any} details a quote's `payDetails[method]` or an order's `payDetails`: { name, instructions, accounts }
 * @returns {HTMLElement | null}
 */
export const payDetailsBox = (doc, t, details) => {
	if (!details || typeof details !== 'object') return null;
	const accounts = listOf(details.accounts)
		.map((account) => ({
			label: textOf(account?.label),
			rows: listOf(account?.rows).filter((row) => textOf(row?.label) !== '' && textOf(row?.value) !== ''),
		}))
		.filter((account) => account.rows.length > 0);
	const instructions = textOf(details.instructions);
	if (accounts.length === 0 && !instructions) return null;
	return h(
		doc,
		'div',
		{ class: 'box pay-details' },
		h(doc, 'h3', {}, t('checkout.pay.title', { method: textOf(details.name) })),
		...accounts.flatMap((account) => [
			account.label ? h(doc, 'p', { class: 'meta' }, account.label) : null,
			h(
				doc,
				'dl',
				{ class: 'totals' },
				...account.rows.flatMap((row) => [h(doc, 'dt', {}, textOf(row.label)), h(doc, 'dd', {}, textOf(row.value))]),
			),
		]),
		instructions ? h(doc, 'p', { class: 'meta' }, instructions) : null,
	);
};

/**
 * What a placed order shows for paying it by transfer: its bank details, the merchant's note for its payment method,
 * the proof already sent and, while it takes one, the proof form. `onOrder` gets the order after a proof was sent.
 * @param {{ doc: Document, t: Texts, shop: Shop, config: WidgetConfig, win: Window & typeof globalThis, order: any,
 *   onOrder: (order: any) => void }} input
 * @returns {HTMLElement[]}
 */
export const transferParts = ({ doc, t, shop, config, win, order, onOrder }) => {
	const { dateText } = formatsOf(config, win);
	const proof = order.payment?.proof;
	return /** @type {HTMLElement[]} */ (
		[
			payDetailsBox(doc, t, order.payDetails),
			order.notes?.payment ? h(doc, 'p', { class: 'meta' }, order.notes.payment) : null,
			proof
				? h(
						doc,
						'p',
						{ class: 'save' },
						proof.reference
							? t('checkout.pay.proofSentRef', { date: dateText(proof.at), reference: proof.reference })
							: t('checkout.pay.proofSent', { date: dateText(proof.at) }),
					)
				: null,
			order.canSendProof === true ? proofForm({ doc, t, shop, config, win, order, onOrder }) : null,
		].filter(Boolean)
	);
};

/**
 * The transfer proof form: the receipt's file and the transfer's reference.
 * @param {{ doc: Document, t: Texts, shop: Shop, config: WidgetConfig, win: Window & typeof globalThis, order: any,
 *   onOrder: (order: any) => void }} input
 */
const proofForm = ({ doc, t, shop, config, win, order, onOrder }) => {
	const id = encodeURIComponent(order.id);
	const file = /** @type {HTMLInputElement} */ (h(doc, 'input', { type: 'file', accept: Object.keys(PROOF_TYPES).join(',') }));
	const reference = /** @type {HTMLInputElement} */ (h(doc, 'input', { maxlength: '120', autocomplete: 'off' }));
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const submit = h(doc, 'button', { type: 'submit' }, t('checkout.pay.proofSend'));
	const form = h(
		doc,
		'form',
		{ class: 'box proof-form' },
		h(doc, 'h3', {}, t(order.payment?.proof ? 'checkout.pay.proofAgain' : 'checkout.pay.proofTitle')),
		field(doc, `ss-proof-file-${order.id}`, t('checkout.pay.proofFile'), file),
		field(doc, `ss-proof-reference-${order.id}`, t('checkout.pay.proofReference'), reference),
		submit,
		status,
	);
	/** @param {string} text */
	const say = (text) => {
		status.textContent = text;
		submit.removeAttribute('disabled');
	};
	/** @param {any} answer */
	const refused = (answer) => say(problemText(config, 'checkout.pay.problem.', codeOf(answer), 'checkout.pay.proofFailed'));
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const chosen = file.files?.[0];
		if (!chosen) return say(t('checkout.pay.proofNeeded'));
		if (!Object.hasOwn(PROOF_TYPES, chosen.type) || chosen.size < 1 || chosen.size > PROOF_MAX_BYTES)
			return say(t('checkout.pay.proofInvalid'));
		submit.setAttribute('disabled', '');
		status.textContent = t('checkout.pay.proofSending');
		const signed = await shop.call(`/v1/shop/orders/${id}/proof/upload`, {
			method: 'POST',
			body: { type: chosen.type, size: chosen.size },
		});
		if (!signed.ok) return refused(signed);
		const { method, url, headers } = signed.data.upload;
		try {
			const put = await win.fetch(url, { method, headers, body: chosen });
			if (!put.ok) return say(t('checkout.pay.proofFailed'));
		} catch {
			return say(t('checkout.pay.proofFailed'));
		}
		const sent = await shop.call(`/v1/shop/orders/${id}/proof`, {
			method: 'POST',
			body: { key: signed.data.key, reference: reference.value.trim() },
		});
		if (!sent.ok) return refused(sent);
		onOrder(sent.data.order);
	});
	return form;
};
