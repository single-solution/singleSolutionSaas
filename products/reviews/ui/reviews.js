/**
 * Mode A default renderer of the `display` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; keyboard operable; announces changes politely; reserves its minimum height (no layout shift).
 * Variants: `stars` (compact rating for product lists and headers), `summary` (average, count, distribution) and
 * `list` (summary + sort, filters, reviews, "show more" and the write-a-review form).
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/reviews.js').ReviewsState} ReviewsState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */
/**
 * @typedef {object} RenderActions the headless actions the renderer uses
 * @property {(sort: string) => unknown} setSort
 * @property {(name: any, value: number | boolean | null) => unknown} setFilter
 * @property {() => unknown} loadMore
 * @property {() => unknown} openForm
 * @property {() => unknown} closeForm
 * @property {(input: Record<string, unknown>) => unknown} submit
 */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-reviews { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-reviews-min-height, 3rem); }
.ss-reviews--stars { display: inline-flex; gap: var(--ss-space-1); align-items: center; padding: 0; min-height: 0; background: none; }
.ss-reviews__stars { color: var(--ss-color-primary); letter-spacing: 0.05em; }
.ss-reviews__meta, .ss-reviews__item time { color: var(--ss-color-text-muted); }
.ss-reviews__bar { width: 100%; height: var(--ss-space-2); accent-color: var(--ss-color-primary); }
.ss-reviews__list { list-style: none; margin: 0; padding: 0; }
.ss-reviews__item { border-top: 1px solid var(--ss-color-border); padding: var(--ss-space-2) 0; }
.ss-reviews__badge { color: var(--ss-color-success); font-weight: var(--ss-font-weight-bold, 700); }
.ss-reviews__reply { border-inline-start: 2px solid var(--ss-color-border); padding-inline-start: var(--ss-space-2); }
.ss-reviews__button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
.ss-reviews__button:focus-visible, .ss-reviews select:focus-visible, .ss-reviews input:focus-visible,
.ss-reviews textarea:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-reviews__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-reviews * { transition: none; } }
`;

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children)
		if (child !== null && child !== undefined) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/** @param {number} value @param {number} scale */
const starText = (value, scale) => {
	const full = Math.max(0, Math.min(scale, Math.round(value)));
	return '★'.repeat(full) + '☆'.repeat(scale - full);
};

/**
 * Render the element.
 * @param {{ state: ReviewsState, actions: RenderActions, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'stars' || theme.variant === 'summary' ? theme.variant : 'list';
	const summary = state.summary;
	const scale = summary?.scale ?? 5;
	const stars = el(
		dom,
		'span',
		{
			class: 'ss-reviews__stars',
			role: 'img',
			'aria-label':
				summary && summary.count > 0 ? t('reviews.stars.label', { average: summary.average, scale }) : t('reviews.empty'),
		},
		[starText(summary?.average ?? 0, scale)],
	);
	const status = el(
		dom,
		'p',
		{ class: 'ss-reviews__error', role: 'status', 'aria-live': 'polite' },
		state.error ? [state.error] : [],
	);
	const root = (/** @type {any[]} */ children) =>
		el(
			dom,
			'section',
			{
				class: `ss-reviews ss-reviews--${variant}`,
				role: 'region',
				'aria-label': t('reviews.title'),
				'aria-busy': String(state.status === 'loading'),
			},
			[slots.before ?? null, ...children, status, slots.after ?? null],
		);
	if (variant === 'stars')
		return root([stars, state.countText ? el(dom, 'span', { class: 'ss-reviews__meta' }, [`(${state.countText})`]) : null]);

	/** @type {any[]} */
	const body = [el(dom, 'h2', { class: 'ss-reviews__title' }, [t('reviews.title')])];
	if (summary && summary.count > 0 && summary.display?.showSummary !== false) {
		body.push(stars, el(dom, 'p', { class: 'ss-reviews__meta' }, [`${state.averageText ?? ''} · ${state.countText ?? ''}`]));
		if (summary.display?.showDistribution !== false)
			body.push(
				el(
					dom,
					'ul',
					{ class: 'ss-reviews__list', 'aria-label': t('reviews.distribution.label') },
					(summary.distribution ?? []).map((/** @type {any} */ row) =>
						el(dom, 'li', {}, [
							el(dom, 'span', {}, [t('reviews.distribution.row', { rating: row.rating, percent: row.percent })]),
							el(dom, 'progress', {
								class: 'ss-reviews__bar',
								max: '100',
								value: String(row.percent),
								'aria-hidden': 'true',
							}),
						]),
					),
				),
			);
		if (summary.display?.showAttributes !== false)
			for (const attribute of summary.attributes ?? [])
				body.push(
					el(dom, 'p', { class: 'ss-reviews__meta' }, [
						`${attribute.label}: ${attribute.average} (${attribute.min}–${attribute.max})`,
					]),
				);
	}
	if (variant === 'summary') return root(body);

	if (state.status === 'loading') body.push(el(dom, 'p', { class: 'ss-reviews__meta' }, [t('reviews.loading')]));
	if (state.sorts.length > 1) {
		const select = el(dom, 'select', { 'aria-label': t('reviews.sort.label') }, []);
		for (const sort of state.sorts) {
			const option = el(dom, 'option', { value: sort, ...(sort === state.sort ? { selected: '' } : {}) }, [
				t(`reviews.sort.${sort}`),
			]);
			select.append(option);
		}
		select.addEventListener('change', (/** @type {any} */ event) => actions.setSort(event.target.value));
		body.push(select);
	}
	for (const name of state.filters) {
		if (name === 'rating') continue;
		const label = t(name === 'verified' ? 'reviews.filter.verified' : 'reviews.filter.photos');
		const on = state.filter[/** @type {'verified' | 'photos'} */ (name)] === true;
		const toggle = el(dom, 'button', { type: 'button', class: 'ss-reviews__filter', 'aria-pressed': String(on) }, [label]);
		toggle.addEventListener('click', () => actions.setFilter(name, on ? null : true));
		body.push(toggle);
	}
	if (state.status === 'ready' && state.reviews.length === 0)
		body.push(slots.empty ?? el(dom, 'p', { class: 'ss-reviews__meta' }, [t('reviews.empty')]));
	else
		body.push(
			el(
				dom,
				'ul',
				{ class: 'ss-reviews__list', 'aria-label': t('reviews.title') },
				state.reviews.map((review) =>
					el(dom, 'li', { class: 'ss-reviews__item' }, [
						el(dom, 'span', { class: 'ss-reviews__stars', role: 'img', 'aria-label': review.ratingText }, [
							starText(review.rating, review.scale),
						]),
						review.title ? el(dom, 'h3', {}, [review.title]) : null,
						el(dom, 'p', {}, [review.body ?? '']),
						el(dom, 'p', { class: 'ss-reviews__meta' }, [
							review.authorText,
							' · ',
							el(dom, 'time', {}, [review.dateText]),
							review.verified ? el(dom, 'span', { class: 'ss-reviews__badge' }, [` · ${t('reviews.verified')}`]) : null,
						]),
						review.reply
							? el(dom, 'div', { class: 'ss-reviews__reply' }, [
									el(dom, 'strong', {}, [t('reviews.reply')]),
									el(dom, 'p', {}, [review.reply.body]),
								])
							: null,
					]),
				),
			),
		);
	if (state.hasMore) {
		const more = el(dom, 'button', { type: 'button', class: 'ss-reviews__button' }, [t('reviews.more')]);
		if (state.loadingMore) more.setAttribute('disabled', '');
		more.addEventListener('click', () => actions.loadMore());
		body.push(more);
	}
	if (state.canWrite) body.push(renderForm({ state, actions, t, dom }));
	return root(body);
};

/**
 * The write-a-review form (or its opening button).
 * @param {{ state: ReviewsState, actions: RenderActions, t: (key: string, params?: Record<string, string | number>) => string, dom: DomLike }} input
 */
const renderForm = ({ state, actions, t, dom }) => {
	const { form } = state;
	if (!form.open || !form.definition) {
		const open = el(dom, 'button', { type: 'button', class: 'ss-reviews__button' }, [t('reviews.write')]);
		open.addEventListener('click', () => actions.openForm());
		return el(dom, 'div', {}, [open, form.message ? el(dom, 'p', { role: 'status' }, [form.message]) : null]);
	}
	if (form.status === 'submitted') return el(dom, 'p', { role: 'status' }, [form.message ?? '']);
	const definition = form.definition;
	const errorOf = (/** @type {string} */ path) => form.errors.find((e) => e.path === path)?.message ?? null;
	/** @param {string} label @param {any} control @param {string} path */
	const field = (label, control, path) => {
		const error = errorOf(path);
		if (error) control.setAttribute('aria-invalid', 'true');
		return el(dom, 'label', {}, [label, control, error ? el(dom, 'span', { class: 'ss-reviews__error' }, [error]) : null]);
	};
	const rating = el(dom, 'select', { name: 'rating', required: '' }, [
		el(dom, 'option', { value: '' }, ['—']),
		...Array.from({ length: definition.ratingScale }, (_, i) =>
			el(dom, 'option', { value: String(definition.ratingScale - i) }, [
				starText(definition.ratingScale - i, definition.ratingScale),
			]),
		),
	]);
	const title = definition.title.enabled
		? el(dom, 'input', { name: 'title', maxlength: String(definition.title.maxLength) })
		: null;
	const text = el(dom, 'textarea', { name: 'body', maxlength: String(definition.body.maxLength), rows: '4' });
	const name = el(dom, 'input', { name: 'name', maxlength: String(definition.authorName.maxLength), autocomplete: 'name' });
	const submit = el(dom, 'button', { type: 'submit', class: 'ss-reviews__button' }, [t('reviews.form.submit')]);
	if (form.status === 'submitting') submit.setAttribute('disabled', '');
	const cancel = el(dom, 'button', { type: 'button' }, [t('reviews.form.cancel')]);
	cancel.addEventListener('click', () => actions.closeForm());
	const root = el(dom, 'form', { 'aria-label': t('reviews.write'), novalidate: '' }, [
		field(t('reviews.form.rating'), rating, '/rating'),
		title ? field(t('reviews.form.title'), title, '/title') : null,
		field(t('reviews.form.body'), text, '/body'),
		field(t('reviews.form.name'), name, '/author/name'),
		form.message ? el(dom, 'p', { class: 'ss-reviews__error', role: 'alert' }, [form.message]) : null,
		submit,
		cancel,
	]);
	root.addEventListener('submit', (/** @type {any} */ event) => {
		event.preventDefault?.();
		actions.submit({
			rating: rating.value ? Number(rating.value) : undefined,
			...(title ? { title: title.value || undefined } : {}),
			body: text.value || undefined,
			...(name.value ? { author: { name: name.value } } : {}),
		});
	});
	return root;
};
