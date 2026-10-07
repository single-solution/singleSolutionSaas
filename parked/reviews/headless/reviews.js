/**
 * Mode B headless core of the `display` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic and DOM-free. `client` is the element's Mode C client (`@ss/web/element` `createElementApi` with
 * the website's `pk_` key and, when the shopper is signed in, the website's own login token as `SS-Identity`). The
 * default renderer (ui/reviews.js) and any merchant-built UI use exactly this core: the rating summary, the review
 * list with sorting, filters and pagination, stars for product lists, and the write-a-review form.
 */
import { validateReview } from '../core/validate.js';
import { createTranslator } from './strings.js';

/** @typedef {{ code?: string, status?: number, detail?: string, errors?: Array<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Problem }} Result
 */
/**
 * @typedef {object} ReviewsClient the Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown) => Promise<Result<any>>} post
 */
/**
 * @typedef {object} ReviewItem a public review with display texts
 * @property {string} id
 * @property {number} rating
 * @property {number} scale
 * @property {string | null} title
 * @property {string | null} body
 * @property {string} authorText
 * @property {string} ratingText
 * @property {string} dateText
 * @property {boolean} verified
 * @property {{ body: string, at: string } | null} reply
 * @property {Array<{ id: string, url: string, contentType: string }>} photos
 * @property {Array<{ key: string, label: string, value: number }>} attributes
 */
/**
 * @typedef {object} FormState
 * @property {boolean} open
 * @property {'idle' | 'submitting' | 'submitted' | 'error'} status
 * @property {Record<string, any> | null} definition `GET /v1/review-form`
 * @property {Array<{ path: string, code: string, message: string }>} errors
 * @property {string | null} message
 */
/**
 * @typedef {object} ReviewsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string | null} itemId
 * @property {Record<string, any> | null} summary `GET /v1/ratings/{itemId}`
 * @property {string | null} countText
 * @property {string | null} averageText
 * @property {ReadonlyArray<ReviewItem>} reviews
 * @property {string} sort
 * @property {readonly string[]} sorts
 * @property {{ rating: number | null, verified: boolean | null, photos: boolean | null }} filter
 * @property {readonly string[]} filters
 * @property {string | null} cursor
 * @property {boolean} hasMore
 * @property {boolean} loadingMore
 * @property {Readonly<Record<string, { average: number, count: number, scale: number, text: string }>>} stars
 * @property {FormState} form
 * @property {boolean} canWrite
 * @property {string | null} error resolved, user-facing message
 */

const ERROR_KEYS = Object.freeze([
	'identity_required',
	'not_verified',
	'already_reviewed',
	'review_limit',
	'validation_failed',
	'invalid_token',
	'request_closed',
]);

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: ReviewsClient, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createReviews = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['reviews.locale'] || 'en';
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
	const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
	/** @param {number} count */
	const countText = (count) => t(count === 1 ? 'reviews.count.one' : 'reviews.count.other', { count: numbers.format(count) });
	/** @type {Set<(state: ReviewsState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	const sorts = Array.isArray(config.sorts) && config.sorts.length > 0 ? config.sorts : ['newest'];
	/** @type {ReviewsState} */
	let state = /** @type {ReviewsState} */ ({
		status: 'idle',
		itemId: null,
		summary: null,
		countText: null,
		averageText: null,
		reviews: [],
		sort: typeof config.default_sort === 'string' ? config.default_sort : (sorts[0] ?? 'newest'),
		sorts,
		filter: { rating: null, verified: null, photos: null },
		filters: Array.isArray(config.filters) ? config.filters : [],
		cursor: null,
		hasMore: false,
		loadingMore: false,
		stars: {},
		form: { open: false, status: 'idle', definition: null, errors: [], message: null },
		canWrite: config.allow_submit !== false,
		error: null,
	});
	state = Object.freeze(state);
	/** @param {Partial<ReviewsState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Partial<FormState>} patch */
	const setForm = (patch) => set({ form: { ...state.form, ...patch } });
	/** @param {Problem} problem @param {string} fallback */
	const message = (problem, fallback) =>
		t(problem.code && ERROR_KEYS.includes(problem.code) ? `reviews.error.${problem.code}` : fallback);

	/** @param {Record<string, any>} review @returns {ReviewItem} */
	const describe = (review) => {
		const definitions = /** @type {Array<{ key: string, label: string }>} */ (state.summary?.attributes ?? []);
		return {
			id: review.id,
			rating: review.rating,
			scale: review.scale,
			title: review.title ?? null,
			body: review.body ?? null,
			authorText: review.author ?? t('reviews.author.anonymous'),
			ratingText: t('reviews.rating.value', { rating: review.rating, scale: review.scale }),
			dateText: dates.format(new Date(review.submittedAt)),
			verified: review.verifiedPurchase === true,
			reply: review.reply ?? null,
			photos: Array.isArray(review.photos) ? review.photos : [],
			attributes: Object.entries(review.attributes ?? {}).map(([key, value]) => ({
				key,
				label: definitions.find((d) => d.key === key)?.label ?? key,
				value: Number(value),
			})),
		};
	};

	/** Query of the current list. @param {string | null} cursor */
	const listQuery = (cursor) => ({
		'filter[itemId]': state.itemId ?? undefined,
		sort: state.sort,
		limit: typeof config.page_size === 'number' ? config.page_size : undefined,
		'filter[rating]': state.filter.rating ?? undefined,
		'filter[verified]': state.filter.verified ?? undefined,
		'filter[photos]': state.filter.photos ?? undefined,
		cursor: cursor ?? undefined,
	});

	/** @param {boolean} append @returns {Promise<Result<any>>} */
	const fetchList = async (append) => {
		const result = await client.get('/v1/reviews', { query: listQuery(append ? state.cursor : null) });
		if (!result.ok) {
			set({
				status: append ? state.status : 'error',
				loadingMore: false,
				error: message(result.error, 'reviews.error.request_failed'),
			});
			return result;
		}
		const page = result.value;
		const items = /** @type {any[]} */ (page.items ?? []).map(describe);
		set({
			status: 'ready',
			reviews: append ? [...state.reviews, ...items] : items,
			cursor: page.nextCursor ?? null,
			hasMore: page.hasMore === true,
			loadingMore: false,
			error: null,
		});
		return result;
	};

	const actions = Object.freeze({
		/**
		 * Load the summary and the first page for an item (or the whole store without one).
		 * @param {string | null} [itemId]
		 * @returns {Promise<Result<any>>}
		 */
		load: async (itemId = null) => {
			set({ status: 'loading', itemId, error: null });
			if (itemId) {
				const summary = await client.get(`/v1/ratings/${encodeURIComponent(itemId)}`);
				if (!summary.ok) {
					set({ status: 'error', error: message(summary.error, 'reviews.error.request_failed') });
					return summary;
				}
				const value = summary.value;
				set({
					summary: value,
					countText: countText(value.count),
					averageText:
						value.count > 0 ? t('reviews.average', { average: numbers.format(value.average), scale: value.scale }) : null,
				});
			}
			const result = await fetchList(false);
			if (result.ok) emit('viewed', { itemId, count: state.summary?.count ?? state.reviews.length });
			return result;
		},
		/** @param {string} sort */
		setSort: async (sort) => {
			if (!state.sorts.includes(sort)) return /** @type {Result<any>} */ ({ ok: false, error: { code: 'sort_invalid' } });
			set({ sort, cursor: null });
			return fetchList(false);
		},
		/**
		 * @param {'rating' | 'verified' | 'photos'} name
		 * @param {number | boolean | null} value null clears the filter
		 */
		setFilter: async (name, value) => {
			if (!state.filters.includes(name)) return /** @type {Result<any>} */ ({ ok: false, error: { code: 'filter_invalid' } });
			set({ filter: { ...state.filter, [name]: value }, cursor: null });
			return fetchList(false);
		},
		loadMore: async () => {
			if (!state.hasMore || state.loadingMore) return /** @type {Result<any>} */ ({ ok: false, error: { code: 'no_more' } });
			set({ loadingMore: true });
			return fetchList(true);
		},
		/**
		 * Stars for product lists (`GET /v1/ratings?itemIds=`).
		 * @param {string[]} itemIds
		 */
		loadStars: async (itemIds) => {
			const ids = [...new Set(itemIds)].slice(0, 100);
			if (ids.length === 0) return /** @type {Result<any>} */ ({ ok: true, value: { items: [] } });
			const result = await client.get('/v1/ratings', { query: { itemIds: ids.join(',') } });
			if (result.ok) {
				const next = { ...state.stars };
				for (const item of result.value.items ?? [])
					next[item.itemId] = {
						average: item.average,
						count: item.count,
						scale: item.scale,
						text:
							item.count > 0
								? t('reviews.stars.label', { average: numbers.format(item.average), scale: item.scale })
								: t('reviews.empty'),
					};
				set({ stars: next });
			}
			return result;
		},
		/** Open the write-a-review form (loads its definition once). */
		openForm: async () => {
			if (!state.canWrite) return /** @type {Result<any>} */ ({ ok: false, error: { code: 'submit_disabled' } });
			setForm({ open: true, errors: [], message: null, status: 'idle' });
			if (state.form.definition) return /** @type {Result<any>} */ ({ ok: true, value: state.form.definition });
			const result = await client.get('/v1/review-form');
			if (result.ok) setForm({ definition: result.value });
			else setForm({ status: 'error', message: message(result.error, 'reviews.error.request_failed') });
			return result;
		},
		closeForm: () => {
			setForm({ open: false, errors: [], message: null, status: 'idle' });
		},
		/**
		 * Submit a review of the loaded item.
		 * @param {{ rating?: unknown, title?: unknown, body?: unknown, attributes?: unknown, author?: unknown, token?: unknown, photoIds?: unknown }} input
		 * @returns {Promise<Result<any>>}
		 */
		submit: async (input) => {
			const fields = clean(input);
			const problems = validate(fields);
			if (problems.length > 0) {
				setForm({ status: 'error', errors: problems, message: t('reviews.error.validation_failed') });
				return { ok: false, error: { code: 'validation_failed', errors: problems } };
			}
			setForm({ status: 'submitting', errors: [], message: null });
			const body = Object.fromEntries(
				Object.entries({ itemId: state.itemId, ...input }).filter(([, v]) => v !== undefined && v !== ''),
			);
			const result = await client.post('/v1/reviews', body);
			if (!result.ok) {
				const errors = (result.error.errors ?? []).map((e) => ({ ...e, message: fieldMessage(e.code) }));
				setForm({ status: 'error', errors, message: message(result.error, 'reviews.error.submit_failed') });
				return result;
			}
			const published = result.value.status === 'approved';
			setForm({ status: 'submitted', message: t(published ? 'reviews.form.thanks' : 'reviews.form.pending') });
			emit('submitted', { itemId: state.itemId, rating: result.value.rating, status: result.value.status });
			if (published && state.itemId) await actions.load(state.itemId);
			return result;
		},
	});

	/**
	 * Form fields without empty values (an empty input means "not given").
	 * @param {unknown} input
	 * @returns {Record<string, unknown>}
	 */
	const clean = (input) =>
		input && typeof input === 'object'
			? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''))
			: {};

	/** @param {string} code */
	const fieldMessage = (code) => {
		if (code === 'required' || code === 'text_empty') return t('reviews.field.required');
		if (code === 'too_short') return t('reviews.field.too_short', { min: state.form.definition?.body?.minLength ?? 0 });
		if (code === 'too_long') return t('reviews.field.too_long');
		return t('reviews.field.invalid');
	};

	/**
	 * Validate a form input like the API does (limits from `GET /v1/review-form`; nothing to check before it loaded).
	 * @param {unknown} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		const form = state.form.definition;
		if (!form) return [];
		const { problems } = validateReview(
			{ itemId: state.itemId ?? 'unknown', ...clean(input) },
			{
				content: {
					rating_scale: form.ratingScale,
					title_max_length: form.title.enabled ? form.title.maxLength : 0,
					title_required: form.title.required,
					body_required: form.body.required,
					body_min_length: form.body.minLength,
					body_max_length: form.body.maxLength,
					author_name_max_length: form.authorName.maxLength,
					attributes: form.attributes.map((/** @type {any} */ a) => ({ ...a, required: a.required })),
				},
				maxPhotos: form.photos.enabled ? form.photos.max : null,
				server: false,
			},
		);
		return problems.map((p) => ({ ...p, message: fieldMessage(p.code) }));
	};

	return Object.freeze({
		/** @returns {ReviewsState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: ReviewsState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		countText,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
