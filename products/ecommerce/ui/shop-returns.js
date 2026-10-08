/**
 * Returns and warranty claims in the shopper's orders (feature `returns`, PLAN 0.8.8 "Returns and warranty"): the
 * claim form of a delivered order (the lines still claimable and their windows, the kind, the quantities, the reason
 * and photos uploaded straight to the merchant's storage with a signed address) and the shopper's own claims.
 * @module
 */
import { button, codeOf, dateText, field, h, money, problemText, select } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./shop-common.js').ShopSettings} ShopSettings */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** Photo types the claims take. */
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
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
	box.replaceChildren(h(doc, 'p', { class: 'status', role: 'status' }, t('returns.loading')));
	const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(orderId)}/returnable`);
	if (!answer.ok) {
		box.replaceChildren(h(doc, 'p', { class: 'error', role: 'status' }, t('returns.error')));
		return;
	}
	/** @type {any[]} */
	const lines = answer.data.lines.filter((/** @type {any} */ line) => line.claimable > 0);
	/** @type {Array<'return' | 'warranty'>} */
	const kinds = /** @type {Array<'return' | 'warranty'>} */ (['return', 'warranty']).filter((kind) =>
		lines.some((line) => line[kind].open),
	);
	if (kinds.length === 0) {
		box.replaceChildren(h(doc, 'p', { class: 'hint' }, t('returns.none')));
		return;
	}
	const kind = select(
		doc,
		kinds.map((key) => /** @type {[string, string]} */ ([key, t(`returns.kind.${key}`)])),
		kinds[0] ?? 'return',
	);
	const linesBox = h(doc, 'div', { class: 'stack' });
	/** @type {Map<string, HTMLSelectElement>} */
	const quantities = new Map();
	const renderLines = () => {
		quantities.clear();
		const chosen = /** @type {'return' | 'warranty'} */ (kind.value);
		linesBox.replaceChildren(
			...lines
				.filter((line) => line[chosen].open)
				.map((line) => {
					const count = select(
						doc,
						Array.from({ length: line.claimable + 1 }, (_, n) => /** @type {[string, string]} */ ([String(n), String(n)])),
						'0',
					);
					quantities.set(line.lineId, count);
					const name = line.variantName ? `${line.name} (${line.variantName})` : line.name;
					return h(
						doc,
						'div',
						{},
						field(doc, `ss-claim-${line.lineId}`, t('returns.quantity', { name, max: line.claimable }), count),
						h(doc, 'span', { class: 'meta' }, t('returns.until', { date: dateText(line[chosen].until, { time: false }) })),
					);
				}),
		);
	};
	kind.addEventListener('change', renderLines);
	renderLines();
	const reason = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', { maxlength: '1000', rows: '3', required: '' }));
	const { maxPhotos, photoMaxMb } = settings.returns;
	const photos = /** @type {HTMLInputElement} */ (
		h(doc, 'input', { type: 'file', accept: PHOTO_TYPES.join(','), multiple: '' })
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
		field(doc, 'ss-claim-reason', t('returns.reason'), reason),
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
		if (!reason.value.trim()) return void (status.textContent = t('returns.reasonNeeded'));
		const files = [...(photos.files ?? [])];
		if (files.length > maxPhotos) return void (status.textContent = t('returns.tooManyPhotos', { max: maxPhotos }));
		if (files.some((file) => !PHOTO_TYPES.includes(file.type) || file.size > photoMaxMb * 1_048_576))
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
			body: { orderId, kind: kind.value, lines: chosen, reason: reason.value.trim(), photos: uploaded.keys },
			idempotencyKey: attemptKey,
		});
		submit.removeAttribute('disabled');
		if (sent.status !== 0 && sent.status < 500) attemptKey = null;
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
export const renderClaims = async ({ box, t, shop, settings }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
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
					kind: t(`returns.kind.${claim.kind}`),
					status: t(`returns.status.${claim.status}`),
					date: dateText(claim.createdAt, { time: false }),
				}),
			),
			claim.refundAmount > 0
				? h(doc, 'span', { class: 'save' }, t('returns.refunded', { amount: money(claim.refundAmount, settings.currency) }))
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
