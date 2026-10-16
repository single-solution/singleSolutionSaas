/**
 * Returns and warranty claims in the shopper's orders (feature `returns`, PLAN 0.8.8 "Returns and warranty"): the
 * claim form of a delivered order (the lines still claimable and their windows, the kinds the shop offers shoppers, the
 * quantities, the reason — the shop's own list plus "Other" with the shopper's words, or free text when it lists none
 * (E17) — and photos uploaded straight to the merchant's storage with a signed address) and the shopper's own claims,
 * by the shop's names of their kinds and statuses (E18).
 * @module
 */
import { quantityText } from '../core/measure.js';
import { PHOTO_TYPES } from '../core/returns.js';
import { button, field, formatsOf, h, problemText, select } from './shop-common.js';
import { codeOf } from './problem-code.js';

/** A measured line offers at most this many amounts (its steps) to claim. */
const MEASURED_CHOICES = 200;

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./shop-common.js').ShopSettings} ShopSettings */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

const CLAIMS_PAGE = 10;

/**
 * @typedef {object} ClaimContext
 * @property {Texts} t
 * @property {Shop} shop
 * @property {WidgetConfig} config
 * @property {ShopSettings} settings
 * @property {Window & typeof globalThis} win
 */

/**
 * Upload the photos: a signed upload address for each, then the file itself.
 * @param {ClaimContext} context
 * @param {File[]} files
 * @returns {Promise<{ ok: true, keys: string[] } | { ok: false, text: string }>}
 */
const upload = async ({ t, shop, config, win }, files) => {
	/** @type {string[]} */
	const keys = [];
	for (const file of files) {
		const signed = await shop.call('/v1/shop/returns/photos', { method: 'POST', body: { type: file.type, size: file.size } });
		if (!signed.ok) return { ok: false, text: problemText(config, 'returns.problem.', codeOf(signed), 'returns.uploadFailed') };
		const { method, url, headers } = signed.data.upload;
		try {
			const sent = await win.fetch(url, { method, headers, body: file });
			if (!sent.ok) return { ok: false, text: t('returns.uploadFailed') };
		} catch {
			return { ok: false, text: t('returns.uploadFailed') };
		}
		keys.push(signed.data.key);
	}
	return { ok: true, keys };
};

/**
 * The claim form of an order.
 * @param {ClaimContext & { box: HTMLElement, orderId: string, onDone: () => void }} input
 */
export const renderClaimForm = async (input) => {
	const { box, t, shop, config, settings, orderId, onDone } = input;
	const doc = /** @type {Document} */ (box.ownerDocument);
	const { dateText } = formatsOf(config, input.win);
	box.replaceChildren(h(doc, 'p', { class: 'status', role: 'status' }, t('returns.loading')));
	const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(orderId)}/returnable`);
	if (!answer.ok) {
		box.replaceChildren(h(doc, 'p', { class: 'error', role: 'status' }, t('returns.error')));
		return;
	}
	/** @type {any[]} */
	const lines = answer.data.lines.filter((/** @type {any} */ line) => line.claimable > 0);
	// the kinds the shop offers shoppers whose window is open on some line (the server sends them, E17)
	/** @type {Array<{ key: string, label: string, window: 'return' | 'warranty' }>} */
	const kinds = (answer.data.kinds ?? []).filter((/** @type {any} */ kind) => lines.some((line) => line[kind.window]?.open));
	if (kinds.length === 0) {
		box.replaceChildren(h(doc, 'p', { class: 'hint' }, t('returns.none')));
		return;
	}
	const kind = select(
		doc,
		kinds.map((entry) => /** @type {[string, string]} */ ([entry.key, entry.label])),
		kinds[0]?.key ?? '',
	);
	/** The window of the kind chosen. */
	const windowOf = () => kinds.find((entry) => entry.key === kind.value)?.window ?? 'return';
	const linesBox = h(doc, 'div', { class: 'stack' });
	/** @type {Map<string, HTMLSelectElement>} */
	const quantities = new Map();
	const renderLines = () => {
		quantities.clear();
		const chosen = windowOf();
		linesBox.replaceChildren(
			...lines
				.filter((line) => line[chosen].open)
				.map((line) => {
					// an item sold in a unit of its own is claimed in its steps (thousandths of its unit), or all of it
					const measure = line.measure ?? null;
					/** @param {number} n */
					const label = (n) =>
						measure ? t('shop.amount', { quantity: quantityText(n, measure), unit: measure.unit }) : String(n);
					const amounts = measure
						? [
								...Array.from(
									{ length: Math.min(MEASURED_CHOICES, Math.floor(line.claimable / measure.step)) + 1 },
									(_, n) => n * measure.step,
								),
								...(line.claimable % measure.step !== 0 ? [line.claimable] : []),
							]
						: Array.from({ length: line.claimable + 1 }, (_, n) => n);
					const count = select(
						doc,
						amounts.map((n) => /** @type {[string, string]} */ ([String(n), label(n)])),
						'0',
					);
					quantities.set(line.lineId, count);
					const name = line.variantName ? `${line.name} (${line.variantName})` : line.name;
					return h(
						doc,
						'div',
						{},
						field(doc, `ss-claim-${line.lineId}`, t('returns.quantity', { name, max: label(line.claimable) }), count),
						h(doc, 'span', { class: 'meta' }, t('returns.until', { date: dateText(line[chosen].until, { time: false }) })),
					);
				}),
		);
	};
	kind.addEventListener('change', renderLines);
	renderLines();
	// the shop's reasons, plus Other with the shopper's words (when the shop offers it); none listed: free text
	/** @type {string[]} */
	const reasons = (Array.isArray(answer.data.reasons) ? answer.data.reasons : []).filter(
		(/** @type {unknown} */ text) => typeof text === 'string' && text.trim() !== '',
	);
	const offersOther = answer.data.otherReason !== false;
	/** Other's value: no listed reason is empty. */
	const OTHER = '';
	const picked =
		reasons.length > 0
			? select(
					doc,
					[
						...reasons.map((text) => /** @type {[string, string]} */ ([text, text])),
						...(offersOther ? [/** @type {[string, string]} */ ([OTHER, t('returns.reasonOther')])] : []),
					],
					reasons[0] ?? '',
				)
			: null;
	const reason = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', { maxlength: '1000', rows: '3' }));
	const reasonField = field(doc, 'ss-claim-reason', t(picked ? 'returns.reasonOtherText' : 'returns.reason'), reason);
	const showOther = () => {
		reasonField.hidden = picked !== null && picked.value !== OTHER;
	};
	picked?.addEventListener('change', showOther);
	showOther();
	/** The reason sent: the reason picked, else what the shopper typed. */
	const reasonText = () => (picked && picked.value !== OTHER ? picked.value : reason.value.trim());
	const { maxPhotos, photoMaxMb } = settings.returns;
	const photos = /** @type {HTMLInputElement} */ (
		h(doc, 'input', { type: 'file', accept: Object.keys(PHOTO_TYPES).join(','), multiple: '' })
	);
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const submit = h(doc, 'button', { type: 'submit' }, t('returns.submit'));
	const form = h(
		doc,
		'form',
		{ class: 'box' },
		h(doc, 'h2', {}, t('returns.formTitle')),
		field(doc, 'ss-claim-kind', t('returns.kind'), kind),
		linesBox,
		picked ? field(doc, 'ss-claim-reason-pick', t('returns.reason'), picked) : null,
		reasonField,
		maxPhotos > 0 ? field(doc, 'ss-claim-photos', t('returns.photos', { max: maxPhotos, mb: photoMaxMb }), photos) : null,
		submit,
		status,
	);
	/** @type {string | null} */
	let attemptKey = null;
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const chosen = [...quantities]
			.map(([lineId, control]) => ({ lineId, quantity: Number(control.value) }))
			.filter((line) => line.quantity > 0);
		if (chosen.length === 0) return void (status.textContent = t('returns.chooseItems'));
		if (!reasonText()) return void (status.textContent = t('returns.reasonNeeded'));
		const files = [...(photos.files ?? [])];
		if (files.length > maxPhotos) return void (status.textContent = t('returns.tooManyPhotos', { max: maxPhotos }));
		if (files.some((file) => !Object.hasOwn(PHOTO_TYPES, file.type) || file.size > photoMaxMb * 1_048_576))
			return void (status.textContent = t('returns.photoInvalid', { mb: photoMaxMb }));
		submit.setAttribute('disabled', '');
		status.textContent = t('returns.sending');
		const uploaded = await upload(input, files);
		if (!uploaded.ok) {
			submit.removeAttribute('disabled');
			status.textContent = uploaded.text;
			return;
		}
		attemptKey ??= shop.newKey();
		const sent = await shop.call('/v1/shop/returns', {
			method: 'POST',
			body: { orderId, kind: kind.value, lines: chosen, reason: reasonText(), photos: uploaded.keys },
			idempotencyKey: attemptKey,
		});
		submit.removeAttribute('disabled');
		// a lost answer, a server failure or the first try still running: the same claim is sent again with the same key
		if (sent.status !== 0 && sent.status < 500 && codeOf(sent) !== 'in_progress') attemptKey = null;
		if (!sent.ok) {
			status.textContent = problemText(config, 'returns.problem.', codeOf(sent), 'returns.failed');
			return;
		}
		box.replaceChildren(h(doc, 'p', { class: 'hint', role: 'status' }, t('returns.sent', { reference: sent.data.reference })));
		onDone();
	});
	box.replaceChildren(form);
};

/**
 * The shopper's claims, newest first, with Load more.
 * @param {ClaimContext & { box: HTMLElement }} input
 */
export const renderClaims = async ({ box, t, shop, config, settings, win }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
	const { money, dateText } = formatsOf(config, win);
	const list = h(doc, 'ul', { 'aria-label': t('returns.mine') });
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	/** @type {string | null} */
	let cursor = null;
	const more = button(doc, t('returns.more'), () => void load(), { class: 'secondary more' });
	box.replaceChildren(h(doc, 'h2', {}, t('returns.mine')), list, more, status);

	/** @param {any} claim */
	const claimOf = (claim) => {
		const last = claim.history.at(-1);
		return h(
			doc,
			'li',
			{},
			h(doc, 'strong', {}, t('returns.claim', { reference: claim.reference, number: claim.orderNumber })),
			h(
				doc,
				'span',
				{ class: 'meta' },
				t('returns.claimLine', {
					kind: claim.kindLabel,
					status: claim.statusLabel,
					date: dateText(claim.createdAt, { time: false }),
				}),
			),
			claim.refundAmount > 0
				? h(doc, 'span', { class: 'save' }, t('returns.refunded', { amount: money(claim.refundAmount, settings.currency) }))
				: null,
			claim.creditAmount > 0
				? h(
						doc,
						'span',
						{ class: 'save' },
						t('returns.credited', {
							amount: money(claim.creditAmount, settings.currency),
							codes: (claim.creditCodes ?? []).join(', '),
						}),
					)
				: null,
			last?.note ? h(doc, 'p', { class: 'reply' }, last.note) : null,
		);
	};

	const load = async () => {
		const query = new URLSearchParams({ limit: String(CLAIMS_PAGE) });
		if (cursor) query.set('cursor', cursor);
		const answer = await shop.call(`/v1/shop/returns?${query}`);
		if (!answer.ok) {
			status.textContent = t('returns.listError');
			more.hidden = true;
			return;
		}
		list.append(...answer.data.items.map(claimOf));
		cursor = answer.data.nextCursor ?? null;
		more.hidden = !cursor;
		status.textContent = list.children.length === 0 ? t('returns.noClaims') : '';
	};
	await load();
};
