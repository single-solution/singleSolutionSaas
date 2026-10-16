/**
 * The product page's reviews block (feature `reviews`, PLAN 0.8.8: reviews only after delivery): the rating summary,
 * the approved reviews with the shop's replies ("Reviews per page" at a time, more with the cursor) and the form to
 * write one. Per product, a signed-in shopper writes it here; the server decides who may (`review_not_allowed` without
 * a delivered order of the product, `already_reviewed` for a second one). Per item bought (`per: order_line`, E34) the
 * shopper reviews each delivered item from the order page (`ui/my-orders.js`, with {@link reviewForm}), so this block
 * says so instead of showing a form the server would refuse.
 * @module
 */
import { button, codeOf, field, formatsOf, h, problemText, select, settingsOf } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/**
 * The form to write a review: the rating, the merchant's questions (E40: a 1–5 rating or one of its choices, each
 * required or not), a title and the text, sent to `POST /v1/shop/reviews` with `target` (the product, or the order and
 * its line). A lost answer or a server failure is sent again with the same key.
 * @param {{ doc: Document, t: Texts, shop: Shop, config: WidgetConfig, target: Record<string, string>, idPrefix: string,
 *   heading: string, onDone: (status: string) => void, onRefused: (code: string) => void }} input `onDone` gets the
 *   saved review's status; `onRefused` a code that ends the form (`review_not_allowed`, `already_reviewed`)
 * @returns {HTMLFormElement}
 */
export const reviewForm = ({ doc, t, shop, config, target, idPrefix, heading, onDone, onRefused }) => {
	const rating = select(
		doc,
		['5', '4', '3', '2', '1'].map((star) => /** @type {[string, string]} */ ([star, t('reviews.stars', { rating: star })])),
		'5',
	);
	// the merchant's questions, each unanswered at first (E40)
	const questions = settingsOf(config).reviews.questions.map((question) => ({
		question,
		control: select(
			doc,
			[
				/** @type {[string, string]} */ (['', t('reviews.noAnswer')]),
				...(question.type === 'rating'
					? ['5', '4', '3', '2', '1'].map(
							(star) => /** @type {[string, string]} */ ([star, t('reviews.stars', { rating: star })]),
						)
					: question.choices.map((choice) => /** @type {[string, string]} */ ([choice, choice]))),
			],
			'',
		),
	}));
	const title = /** @type {HTMLInputElement} */ (h(doc, 'input', { maxlength: '120' }));
	const body = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', { maxlength: '2000', rows: '4' }));
	const sent = h(doc, 'p', { class: 'status', role: 'status' });
	const submit = h(doc, 'button', { type: 'submit' }, t('reviews.submit'));
	const form = /** @type {HTMLFormElement} */ (
		h(
			doc,
			'form',
			{ class: 'box review-form' },
			h(doc, 'h2', {}, heading),
			field(doc, `${idPrefix}-rating`, t('reviews.rating'), rating),
			...questions.map(({ question, control }) =>
				field(
					doc,
					`${idPrefix}-q-${question.key}`,
					question.required ? question.label : t('reviews.optional', { question: question.label }),
					control,
				),
			),
			field(doc, `${idPrefix}-title`, t('reviews.titleField'), title),
			field(doc, `${idPrefix}-body`, t('reviews.body'), body),
			submit,
			sent,
		)
	);
	/** @type {string | null} */
	let attemptKey = null;
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const unanswered = questions.find(({ question, control }) => question.required && !control.value);
		if (unanswered) return void (sent.textContent = t('reviews.answerNeeded', { question: unanswered.question.label }));
		/** @type {Record<string, number | string>} */
		const answers = Object.fromEntries(
			questions
				.filter(({ control }) => control.value)
				.map(({ question, control }) => [question.key, question.type === 'rating' ? Number(control.value) : control.value]),
		);
		submit.setAttribute('disabled', '');
		attemptKey ??= shop.newKey();
		const answer = await shop.call('/v1/shop/reviews', {
			method: 'POST',
			body: {
				...target,
				rating: Number(rating.value),
				title: title.value.trim(),
				body: body.value.trim(),
				...(Object.keys(answers).length > 0 ? { answers } : {}),
			},
			idempotencyKey: attemptKey,
		});
		submit.removeAttribute('disabled');
		const code = codeOf(answer);
		// a lost answer, a server failure or the first try still running: the same review is sent again with the same key
		if (answer.status !== 0 && answer.status < 500 && code !== 'in_progress') attemptKey = null;
		if (answer.ok) return onDone(String(answer.data.status));
		if (code === 'review_not_allowed' || code === 'already_reviewed') return onRefused(code);
		sent.textContent = problemText(config, 'reviews.problem.', code, 'reviews.failed');
	});
	return form;
};

/**
 * Fill `box` with the reviews of a product.
 * @param {{ box: HTMLElement, t: Texts, shop: Shop, config: WidgetConfig, productId: string }} input
 * @returns {{ identity: () => void }} call `identity` when the shopper signs in or out
 */
export const renderReviews = ({ box, t, shop, config, productId }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
	const { dateText } = formatsOf(config, doc.defaultView);
	const { per, pageSize } = settingsOf(config).reviews;
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
			// the answers to the merchant's questions (E40)
			...(review.answers ?? []).map((/** @type {any} */ given) =>
				h(
					doc,
					'span',
					{ class: 'meta answer' },
					t('reviews.answer', {
						question: given.label,
						answer: given.type === 'rating' ? t('reviews.stars', { rating: given.value }) : given.value,
					}),
				),
			),
			h(
				doc,
				'span',
				{ class: 'meta' },
				t('reviews.by', { name: review.name || t('reviews.anonymous'), date: dateText(review.createdAt, { time: false }) }),
			),
			review.reply ? h(doc, 'p', { class: 'reply' }, h(doc, 'strong', {}, t('reviews.reply')), ' ', review.reply) : null,
		);

	/**
	 * @param {{ average: number, count: number, stars: Record<string, number>, questions?: Array<{ label: string,
	 *   type: string, count: number, average?: number, choices?: Record<string, number> }> }} found
	 */
	const showSummary = (found) => {
		if (found.count === 0) {
			summary.replaceChildren(h(doc, 'p', { class: 'muted' }, t('reviews.none')));
			return;
		}
		// the answers to the merchant's questions: a rating's average, a choice's count per answer (E40)
		const answered = (found.questions ?? [])
			.filter((question) => question.count > 0)
			.map((question) =>
				h(
					doc,
					'li',
					{ class: 'meta' },
					question.type === 'rating'
						? t('reviews.questionAverage', {
								question: question.label,
								average: Number(question.average).toFixed(1),
								count: question.count,
							})
						: t('reviews.answer', {
								question: question.label,
								answer: Object.entries(question.choices ?? {})
									.filter(([, count]) => count > 0)
									.map(([choice, count]) => `${choice} (${count})`)
									.join(', '),
							}),
				),
			);
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
			...(answered.length > 0 ? [h(doc, 'ul', { 'aria-label': t('reviews.questions') }, ...answered)] : []),
		);
	};

	/** @param {boolean} after */
	const load = async (after) => {
		const query = new URLSearchParams({ limit: String(pageSize) });
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
		// per item bought, items are reviewed from the order page (E34)
		if (per === 'order_line') {
			write.replaceChildren(h(doc, 'p', { class: 'hint' }, t('reviews.fromOrders')));
			return;
		}
		if (!shop.signIn()) {
			write.replaceChildren(h(doc, 'p', { class: 'hint' }, t('reviews.signIn')));
			return;
		}
		if (refused) {
			write.replaceChildren(h(doc, 'p', { class: 'hint' }, refused));
			return;
		}
		write.replaceChildren(
			reviewForm({
				doc,
				t,
				shop,
				config,
				target: { productId },
				idPrefix: 'ss-review',
				heading: t('reviews.write'),
				onDone: (status) => {
					write.replaceChildren(
						h(doc, 'p', { class: 'hint', role: 'status' }, t(status === 'approved' ? 'reviews.thanks' : 'reviews.pending')),
					);
					if (status === 'approved') void load(false);
				},
				onRefused: (code) => {
					refused = problemText(config, 'reviews.problem.', code, 'reviews.failed');
					renderForm();
				},
			}),
		);
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
