/**
 * The product page's reviews block (feature `reviews`, PLAN 0.8.8: reviews only after delivery): the rating summary,
 * the approved reviews with the shop's replies (more load with the cursor) and, for a signed-in shopper, the form to
 * write one. The server decides who may review: a shopper without a delivered order of the product is told so
 * (`review_not_allowed`), and a second review is refused (`already_reviewed`).
 * @module
 */
import { button, codeOf, field, formatsOf, h, problemText, select } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** Reviews read at once. */
const PAGE = 10;

/**
 * Fill `box` with the reviews of a product.
 * @param {{ box: HTMLElement, t: Texts, shop: Shop, config: WidgetConfig, productId: string }} input
 * @returns {{ identity: () => void }} call `identity` when the shopper signs in or out
 */
export const renderReviews = ({ box, t, shop, config, productId }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
	const { dateText } = formatsOf(config, doc.defaultView);
	const summary = h(doc, 'div');
	const list = h(doc, 'ul', { 'aria-label': t('reviews.list') });
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const more = button(doc, t('reviews.more'), () => void load(true), { class: 'secondary more' });
	const write = h(doc, 'div');
	box.append(h(doc, 'h2', {}, t('reviews.title')), summary, list, more, status, write);
	/** @type {string | null} */
	let cursor = null;
	let refused = /** @type {string | null} */ (null);

	/** @param {any} review */
	const reviewOf = (review) =>
		h(
			doc,
			'li',
			{ class: 'review' },
			h(doc, 'strong', {}, t('reviews.stars', { rating: review.rating })),
			review.title ? h(doc, 'span', {}, review.title) : null,
			review.body ? h(doc, 'p', {}, review.body) : null,
			h(
				doc,
				'span',
				{ class: 'meta' },
				t('reviews.by', { name: review.name || t('reviews.anonymous'), date: dateText(review.createdAt, { time: false }) }),
			),
			review.reply ? h(doc, 'p', { class: 'reply' }, h(doc, 'strong', {}, t('reviews.reply')), ' ', review.reply) : null,
		);

	/** @param {{ average: number, count: number, stars: Record<string, number> }} found */
	const showSummary = (found) => {
		if (found.count === 0) {
			summary.replaceChildren(h(doc, 'p', { class: 'muted' }, t('reviews.none')));
			return;
		}
		summary.replaceChildren(
			h(
				doc,
				'p',
				{ class: 'amount' },
				t('reviews.summary', { average: Number(found.average).toFixed(1), count: found.count }),
			),
			h(
				doc,
				'ul',
				{ 'aria-label': t('reviews.breakdown') },
				...['5', '4', '3', '2', '1'].map((star) =>
					h(doc, 'li', { class: 'meta' }, t('reviews.starCount', { rating: star, count: found.stars[star] ?? 0 })),
				),
			),
		);
	};

	/** @param {boolean} after */
	const load = async (after) => {
		const query = new URLSearchParams({ limit: String(PAGE) });
		if (after && cursor) query.set('cursor', cursor);
		more.setAttribute('disabled', '');
		const answer = await shop.call(`/v1/shop/products/${encodeURIComponent(productId)}/reviews?${query}`);
		more.removeAttribute('disabled');
		if (!answer.ok) {
			status.textContent = t('reviews.error');
			more.hidden = true;
			return;
		}
		status.textContent = '';
		if (!after) showSummary(answer.data.summary);
		const nodes = answer.data.items.map(reviewOf);
		if (after) list.append(...nodes);
		else list.replaceChildren(...nodes);
		cursor = answer.data.nextCursor ?? null;
		more.hidden = !cursor;
	};

	const renderForm = () => {
		if (!shop.signIn()) {
			write.replaceChildren(h(doc, 'p', { class: 'hint' }, t('reviews.signIn')));
			return;
		}
		if (refused) {
			write.replaceChildren(h(doc, 'p', { class: 'hint' }, refused));
			return;
		}
		const rating = select(
			doc,
			['5', '4', '3', '2', '1'].map((star) => /** @type {[string, string]} */ ([star, t('reviews.stars', { rating: star })])),
			'5',
		);
		const title = /** @type {HTMLInputElement} */ (h(doc, 'input', { maxlength: '120' }));
		const body = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', { maxlength: '2000', rows: '4' }));
		const sent = h(doc, 'p', { class: 'status', role: 'status' });
		const submit = h(doc, 'button', { type: 'submit' }, t('reviews.submit'));
		const form = h(
			doc,
			'form',
			{ class: 'box' },
			h(doc, 'h2', {}, t('reviews.write')),
			field(doc, 'ss-review-rating', t('reviews.rating'), rating),
			field(doc, 'ss-review-title', t('reviews.titleField'), title),
			field(doc, 'ss-review-body', t('reviews.body'), body),
			submit,
			sent,
		);
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			submit.setAttribute('disabled', '');
			const answer = await shop.call('/v1/shop/reviews', {
				method: 'POST',
				body: { productId, rating: Number(rating.value), title: title.value.trim(), body: body.value.trim() },
				idempotencyKey: shop.newKey(),
			});
			submit.removeAttribute('disabled');
			if (answer.ok) {
				write.replaceChildren(
					h(
						doc,
						'p',
						{ class: 'hint', role: 'status' },
						t(answer.data.status === 'approved' ? 'reviews.thanks' : 'reviews.pending'),
					),
				);
				if (answer.data.status === 'approved') void load(false);
				return;
			}
			const code = codeOf(answer);
			if (code === 'review_not_allowed' || code === 'already_reviewed') {
				refused = problemText(config, 'reviews.problem.', code, 'reviews.failed');
				renderForm();
				return;
			}
			sent.textContent = problemText(config, 'reviews.problem.', code, 'reviews.failed');
		});
		write.replaceChildren(form);
	};

	void load(false);
	renderForm();
	return {
		identity: () => {
			refused = null;
			renderForm();
		},
	};
};
