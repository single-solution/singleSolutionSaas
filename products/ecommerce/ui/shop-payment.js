/**
 * Paying by bank transfer in the shopper widgets (E24): the bank details a quote or an order carries (from Payments,
 * only the ones the merchant filled in), the merchant's note for the payment method, and, while an order waits for a
 * payment staff record (`canSendProof`), the transfer proof: the file goes straight to the merchant's storage with a
 * signed address (`POST /v1/shop/orders/:id/proof/upload`), then `POST /v1/shop/orders/:id/proof` sends it with the
 * shopper's reference. The cart shows the details before the order is placed; its success page and My orders show the
 * details, the proof sent and the proof form.
 * @module
 */
import { codeOf, field, formatsOf, h, problemText } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** The bank details shown, in Payments' order (`instructions` follows as its own paragraph). */
const BANK_FIELDS = Object.freeze([
	'accountHolder',
	'bankName',
	'accountNumber',
	'routingNumber',
	'sortCode',
	'branchCode',
	'iban',
	'bic',
]);
/** The files a transfer proof may be, and its largest size (as the server takes them). */
export const PROOF_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export const PROOF_MAX_BYTES = 10 * 1_048_576;

/**
 * The bank details box: each detail given, then the instructions; null when there is nothing to show.
 * @param {Document} doc
 * @param {Texts} t
 * @param {any} details a quote's or an order's `bankDetails`
 * @returns {HTMLElement | null}
 */
export const bankDetailsBox = (doc, t, details) => {
	if (!details || typeof details !== 'object') return null;
	const given = BANK_FIELDS.filter((name) => typeof details[name] === 'string' && details[name].trim() !== '');
	const instructions = typeof details.instructions === 'string' ? details.instructions.trim() : '';
	if (given.length === 0 && !instructions) return null;
	return h(
		doc,
		'div',
		{ class: 'box bank-details' },
		h(doc, 'h3', {}, t('checkout.bank.title')),
		given.length > 0
			? h(
					doc,
					'dl',
					{ class: 'totals' },
					...given.flatMap((name) => [h(doc, 'dt', {}, t(`checkout.bank.${name}`)), h(doc, 'dd', {}, details[name])]),
				)
			: null,
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
			bankDetailsBox(doc, t, order.bankDetails),
			order.notes?.payment ? h(doc, 'p', { class: 'meta' }, order.notes.payment) : null,
			proof
				? h(
						doc,
						'p',
						{ class: 'save' },
						proof.reference
							? t('checkout.bank.proofSentRef', { date: dateText(proof.at), reference: proof.reference })
							: t('checkout.bank.proofSent', { date: dateText(proof.at) }),
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
	const file = /** @type {HTMLInputElement} */ (h(doc, 'input', { type: 'file', accept: PROOF_TYPES.join(',') }));
	const reference = /** @type {HTMLInputElement} */ (h(doc, 'input', { maxlength: '120', autocomplete: 'off' }));
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const submit = h(doc, 'button', { type: 'submit' }, t('checkout.bank.proofSend'));
	const form = h(
		doc,
		'form',
		{ class: 'box proof-form' },
		h(doc, 'h3', {}, t(order.payment?.proof ? 'checkout.bank.proofAgain' : 'checkout.bank.proofTitle')),
		field(doc, `ss-proof-file-${order.id}`, t('checkout.bank.proofFile'), file),
		field(doc, `ss-proof-reference-${order.id}`, t('checkout.bank.proofReference'), reference),
		submit,
		status,
	);
	/** @param {string} text */
	const say = (text) => {
		status.textContent = text;
		submit.removeAttribute('disabled');
	};
	/** @param {any} answer */
	const refused = (answer) => say(problemText(config, 'checkout.bank.problem.', codeOf(answer), 'checkout.bank.proofFailed'));
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const chosen = file.files?.[0];
		if (!chosen) return say(t('checkout.bank.proofNeeded'));
		if (!PROOF_TYPES.includes(chosen.type) || chosen.size < 1 || chosen.size > PROOF_MAX_BYTES)
			return say(t('checkout.bank.proofInvalid'));
		submit.setAttribute('disabled', '');
		status.textContent = t('checkout.bank.proofSending');
		const signed = await shop.call(`/v1/shop/orders/${id}/proof/upload`, {
			method: 'POST',
			body: { type: chosen.type, size: chosen.size },
		});
		if (!signed.ok) return refused(signed);
		const { method, url, headers } = signed.data.upload;
		try {
			const put = await win.fetch(url, { method, headers, body: chosen });
			if (!put.ok) return say(t('checkout.bank.proofFailed'));
		} catch {
			return say(t('checkout.bank.proofFailed'));
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
