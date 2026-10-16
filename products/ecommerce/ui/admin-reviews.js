/**
 * Reviews moderation in the customers admin widget (feature `reviews`, ticket with `reviews.moderate`; PLAN 0.8.8
 * Reviews, 0.6): a list-and-detail screen — the count of matching reviews as a badge, status chips (waiting first) with
 * their counts, and the reviews of one product (set from a review's More menu, removable) — beside one review: its
 * rating, text, figures (its product by name) and reply, with Approve and Reject as buttons, and Reply, Back to waiting
 * (an approved or rejected review is hidden again until approved), the product's reviews and Delete (last, in danger
 * text, behind its typed confirmation) in the More menu. Newest first.
 * @module
 */
import { query } from './admin-kit.js';
import { card, chipFilter, detailHead, listScreen, scopeChip } from './admin-screen.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-screen.js').Detail} Detail */

/** Review statuses and their tones. @type {Record<string, Tone>} */
const TONES = Object.freeze({ pending: 'warning', approved: 'success', rejected: 'danger' });

/**
 * A rating as stars.
 * @param {number} rating
 */
const stars = (rating) => `${'★'.repeat(Math.min(5, rating))}${'☆'.repeat(Math.max(0, 5 - rating))}`;

/**
 * The reviews section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const reviewsTab = (kit, panel) => {
	const { t } = kit;
	const reload = () => void screen.reload();
	const chips = chipFilter(kit, {
		label: t('admin.status'),
		choices: [
			...Object.keys(TONES).map((key) => ({ value: key, label: t(`customersAdmin.review.${key}`) })),
			{ value: '', label: t('admin.all') },
		],
		value: 'pending',
		onChange: reload,
	});
	const product = scopeChip(kit, reload);
	const counts = async () => {
		const productId = product.value();
		const [total, byStatus] = await Promise.all([
			kit.call('GET', `/v1/admin/reviews/count${query({ status: chips.value(), productId })}`),
			kit.call('GET', `/v1/admin/reviews/counts${query({ productId, by: 'status' })}`),
		]);
		screen.count(total);
		chips.counts(byStatus);
	};
	const screen = listScreen(kit, panel, {
		title: t('customersAdmin.reviews'),
		path: (cursor) => `/v1/admin/reviews${query({ status: chips.value(), productId: product.value(), cursor })}`,
		row: (review) => ({
			name: review.title || stars(review.rating),
			figure: stars(review.rating),
			meta: [
				t(`customersAdmin.review.${review.status}`),
				review.name,
				review.productName || review.productId,
				kit.when(review.createdAt),
			]
				.filter(Boolean)
				.join(' · '),
			tone: TONES[review.status] ?? 'neutral',
			toneLabel: t(`customersAdmin.review.${review.status}`),
		}),
		open: (review, detail) =>
			renderReview(kit, review, detail, '', (shown) =>
				product.set(
					shown.productId,
					t('customersAdmin.reviewsOf', { product: shown.productName || shown.productId }),
					t('customersAdmin.allReviews'),
				),
			),
		empty: t('customersAdmin.noReviews'),
		nothing: t('customersAdmin.nothingReviews'),
		filters: [chips.node, product.node],
		counts,
	});
	void screen.reload();
};

/**
 * One review in the detail pane (the list's answer has every field).
 * @param {Kit} kit @param {any} review @param {Detail} detail @param {string} message
 * @param {(review: any) => void} ofProduct narrow the list to the review's product
 */
const renderReview = (kit, review, detail, message, ofProduct) => {
	const { t } = kit;
	const note = kit.status();
	/** @param {string} method @param {string} suffix @param {unknown} [body] @returns {Promise<string | null>} */
	const act = async (method, suffix, body) => {
		const answer = await kit.call(method, `/v1/admin/reviews/${review.id}${suffix}`, body);
		if (!answer.ok) return kit.reason(answer);
		if (method === 'DELETE') {
			await detail.reload();
			return null;
		}
		// moderation answers do not name the product; the list's name stays
		const next = { productName: review.productName, ...answer.data };
		renderReview(kit, next, detail, t('admin.saved'), ofProduct);
		detail.changed(next);
		return null;
	};
	/** @param {string} suffix */
	const moderate = (suffix) => async () => {
		const error = await act('POST', suffix);
		if (error) kit.say(note, error, true);
	};
	const reply = () => {
		const text = kit.area(review.reply ?? '', { maxlength: '2000', rows: '5' });
		kit.dialog({
			title: t('customersAdmin.replyTitle'),
			body: [kit.field(t('customersAdmin.reply'), text)],
			submitLabel: t('customersAdmin.saveReply'),
			onSubmit: () => act('POST', '/reply', { reply: text.value }),
		});
	};
	const remove = () =>
		kit.dialog({
			title: t('customersAdmin.deleteReview'),
			body: [kit.text('p', {}, t('customersAdmin.deleteReviewHint'))],
			submitLabel: t('admin.delete'),
			danger: true,
			confirmText: t('customersAdmin.deleteWord'),
			onSubmit: () => act('DELETE', ''),
		});
	kit.put(detail.pane, [
		detail.back,
		detailHead(kit, {
			title: review.title || stars(review.rating),
			badges: [kit.badge(t(`customersAdmin.review.${review.status}`), TONES[review.status])],
			actions: [
				review.status === 'approved'
					? null
					: kit.button(t('customersAdmin.approve'), moderate('/approve'), { primary: true }),
				review.status === 'rejected' ? null : kit.button(t('customersAdmin.reject'), moderate('/reject')),
			],
			more: [
				{ label: t(review.reply ? 'customersAdmin.editReply' : 'customersAdmin.replyTitle'), onSelect: reply },
				review.status === 'pending' ? null : { label: t('customersAdmin.backToPending'), onSelect: moderate('/pending') },
				{ label: t('customersAdmin.productReviews'), onSelect: () => ofProduct(review) },
				{ label: t('customersAdmin.deleteReview'), onSelect: remove, danger: true },
			],
		}),
		note,
		kit.fieldGrid([
			[t('customersAdmin.rating'), `${stars(review.rating)} ${review.rating}/5`],
			[t('customersAdmin.reviewer'), review.name],
			[t('customersAdmin.product'), review.productName ? `${review.productName} (${review.productId})` : review.productId],
			[t('customersAdmin.orderNumber'), review.orderId],
			[t('customersAdmin.userId'), review.userId],
			[t('customersAdmin.written'), kit.when(review.createdAt)],
			// the answers to the merchant's review questions (E40)
			...(review.answers ?? []).map((/** @type {any} */ given) => [
				given.label,
				given.type === 'rating' ? `${stars(given.value)} ${given.value}/5` : String(given.value),
			]),
		]),
		kit.masonry([
			card(kit, t('customersAdmin.reviewText'), [kit.text('p', {}, review.body)]),
			card(kit, t('customersAdmin.reply'), [
				kit.text('p', { class: review.reply ? '' : 'muted' }, review.reply || t('customersAdmin.noReply')),
			]),
		]),
	]);
	kit.say(note, message);
};
