/**
 * Request validation (pure): every Mode C body is checked here before anything is stored, returning field problems
 * `{ path, code }` (JSON Pointer paths) that the API turns into RFC 9457 `errors[]`. Limits come from the element
 * configuration (content, photos, moderation, qna, import), never from constants in code.
 * @module
 */
import { sanitizeText, singleLine } from './text.js';

/** Opaque ids of items, variants, orders, photos and requests. */
export const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
/** Customer keys: Graph ids or the website's identity subjects (no whitespace or control characters). */
// eslint-disable-next-line no-control-regex -- control characters are what the pattern refuses
export const CUSTOMER_PATTERN = /^[^\s\u0000-\u001F\u007F]{1,255}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** @typedef {{ path: string, code: string }} FieldProblem */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} body
 * @param {Record<string, (value: unknown) => string | null | FieldProblem[]>} fields field → check returning a code
 *   (null = ok) or nested problems
 * @param {string[]} required
 * @param {string} [base] JSON Pointer prefix
 * @returns {FieldProblem[]}
 */
export const checkFields = (body, fields, required, base = '') => {
	if (!isObject(body)) return [{ path: base, code: 'body_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(body))
		if (!Object.hasOwn(fields, key)) problems.push({ path: `${base}/${key}`, code: 'unknown_field' });
	for (const [key, test] of Object.entries(fields)) {
		if (body[key] === undefined || body[key] === null) {
			if (required.includes(key)) problems.push({ path: `${base}/${key}`, code: 'required' });
			continue;
		}
		const result = test(body[key]);
		if (Array.isArray(result)) problems.push(...result.map((p) => ({ ...p, path: `${base}/${key}${p.path}` })));
		else if (result) problems.push({ path: `${base}/${key}`, code: result });
	}
	return problems;
};

/** @param {unknown} v */
export const idCheck = (v) => (typeof v === 'string' && ID_PATTERN.test(v) ? null : 'id_invalid');
/** @param {unknown} v */
export const customerCheck = (v) => (typeof v === 'string' && CUSTOMER_PATTERN.test(v) ? null : 'customer_invalid');
/** @param {unknown} v */
const emailCheck = (v) => (typeof v === 'string' && v.length <= 320 && EMAIL.test(v) ? null : 'email_invalid');
/** @param {unknown} v */
const phoneCheck = (v) => (typeof v === 'string' && PHONE.test(v) ? null : 'phone_invalid');
/** @param {unknown} v */
const localeCheck = (v) => (typeof v === 'string' && v.length <= 20 && LOCALE.test(v) ? null : 'locale_invalid');
/** @param {unknown} v */
const boolCheck = (v) => (typeof v === 'boolean' ? null : 'boolean_invalid');
/** @param {unknown} v */
const dateCheck = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? null : 'date_invalid');
/** @param {number} max */
const nameCheck = (max) => (/** @type {unknown} */ v) =>
	typeof v === 'string' && singleLine(v, max + 1).length > 0 && singleLine(v, max + 1).length <= max ? null : 'name_invalid';
/** @param {unknown} v */
const customCheck = (v) => {
	if (!isObject(v) || Object.keys(v).length > 50) return 'custom_invalid';
	for (const [key, value] of Object.entries(v)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) return 'custom_invalid';
		const ok =
			value === null ||
			typeof value === 'boolean' ||
			(typeof value === 'number' && Number.isFinite(value)) ||
			(typeof value === 'string' && value.length <= 500);
		if (!ok) return 'custom_invalid';
	}
	return null;
};

/**
 * Length-checked free text: sanitised length between `min` and `max`.
 * @param {{ min?: number, max: number }} limits
 */
const textCheck =
	({ min = 1, max }) =>
	(/** @type {unknown} */ v) => {
		if (typeof v !== 'string') return 'text_invalid';
		const clean = sanitizeText(v, max + 1);
		if (clean.length < Math.max(1, min)) return clean.length === 0 ? 'text_empty' : 'too_short';
		return clean.length > max ? 'too_long' : null;
	};

/**
 * @typedef {object} ContentLimits
 * @property {number} rating_scale
 * @property {number} title_max_length
 * @property {boolean} title_required
 * @property {boolean} body_required
 * @property {number} body_min_length
 * @property {number} body_max_length
 * @property {number} author_name_max_length
 * @property {Array<{ key: string, label: string, min: number, max: number, low_label?: string, high_label?: string, required?: boolean }>} attributes
 */

/**
 * @param {ContentLimits} content
 * @returns {(value: unknown) => string | FieldProblem[] | null}
 */
const attributesCheck = (content) => (value) => {
	if (!isObject(value)) return 'attributes_invalid';
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const [key, rating] of Object.entries(value)) {
		const def = content.attributes.find((attribute) => attribute.key === key);
		if (!def) problems.push({ path: `/${key}`, code: 'unknown_attribute' });
		else if (!Number.isInteger(rating) || /** @type {number} */ (rating) < def.min || /** @type {number} */ (rating) > def.max)
			problems.push({ path: `/${key}`, code: 'attribute_invalid' });
	}
	return problems;
};

/**
 * Required attribute ratings missing from a submission.
 * @param {unknown} attributes
 * @param {ContentLimits} content
 * @returns {FieldProblem[]}
 */
const missingAttributes = (attributes, content) =>
	content.attributes
		.filter((def) => def.required && !(isObject(attributes) && attributes[def.key] !== undefined))
		.map((def) => ({ path: `/attributes/${def.key}`, code: 'required' }));

/**
 * @typedef {object} ReviewValue
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {number} rating
 * @property {string | null} title
 * @property {string | null} body
 * @property {Record<string, number>} attributes
 * @property {string[]} photoIds
 * @property {{ name: string | null, email: string | null }} author
 * @property {string | null} customerId
 * @property {string | null} orderId
 * @property {string | null} token
 * @property {string | null} locale
 * @property {string | null} externalId
 * @property {Record<string, unknown> | null} custom
 */

/**
 * `POST /v1/reviews` — a review submission. `server`: an `sk_` caller may name the customer, the order and an
 * external id; browsers (`pk_`) identify the customer with SS-Identity or a request link `token` instead.
 * @param {unknown} body
 * @param {{ content: ContentLimits, maxPhotos: number | null, server: boolean }} options `maxPhotos` null = photos off
 * @returns {{ problems: FieldProblem[], value: ReviewValue | null }}
 */
export const validateReview = (body, { content, maxPhotos, server }) => {
	/** @type {Record<string, (value: unknown) => string | FieldProblem[] | null>} */
	const fields = {
		itemId: idCheck,
		variantId: idCheck,
		rating: (v) =>
			Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= content.rating_scale
				? null
				: 'rating_invalid',
		title: (v) => (content.title_max_length === 0 ? 'title_not_allowed' : textCheck({ max: content.title_max_length })(v)),
		body: textCheck({ min: content.body_min_length, max: content.body_max_length }),
		attributes: attributesCheck(content),
		photoIds: (v) => {
			if (maxPhotos === null) return 'photos_disabled';
			if (!Array.isArray(v) || v.length > maxPhotos) return 'photos_invalid';
			if (new Set(v).size !== v.length) return 'photos_invalid';
			return v.every((id) => idCheck(id) === null) ? null : 'photos_invalid';
		},
		author: (v) => checkFields(v, { name: nameCheck(content.author_name_max_length), email: emailCheck }, []),
		orderId: idCheck,
		locale: localeCheck,
		custom: customCheck,
		...(server
			? { customerId: customerCheck, externalId: idCheck }
			: { token: (v) => (typeof v === 'string' && v.length <= 2048 ? null : 'token_invalid') }),
	};
	const required = [
		'itemId',
		'rating',
		...(content.body_required ? ['body'] : []),
		...(content.title_required && content.title_max_length > 0 ? ['title'] : []),
	];
	const problems = checkFields(body, fields, required);
	if (isObject(body)) problems.push(...missingAttributes(body.attributes, content));
	if (problems.length > 0 || !isObject(body)) return { problems, value: null };
	const author = isObject(body.author) ? body.author : {};
	return {
		problems,
		value: {
			itemId: /** @type {string} */ (body.itemId),
			variantId: typeof body.variantId === 'string' ? body.variantId : null,
			rating: /** @type {number} */ (body.rating),
			title: typeof body.title === 'string' ? singleLine(body.title, content.title_max_length) || null : null,
			body: typeof body.body === 'string' ? sanitizeText(body.body, content.body_max_length) || null : null,
			attributes: /** @type {Record<string, number>} */ (isObject(body.attributes) ? { ...body.attributes } : {}),
			photoIds: Array.isArray(body.photoIds) ? /** @type {string[]} */ ([...body.photoIds]) : [],
			author: {
				name: typeof author.name === 'string' ? singleLine(author.name, content.author_name_max_length) : null,
				email: typeof author.email === 'string' ? author.email : null,
			},
			customerId: typeof body.customerId === 'string' ? body.customerId : null,
			orderId: typeof body.orderId === 'string' ? body.orderId : null,
			token: typeof body.token === 'string' ? body.token : null,
			locale: typeof body.locale === 'string' ? body.locale : null,
			externalId: typeof body.externalId === 'string' ? body.externalId : null,
			custom: isObject(body.custom) ? { ...body.custom } : null,
		},
	};
};

/** @param {unknown} v */
const contactCheck = (v) => checkFields(v, { name: nameCheck(120), email: emailCheck, phone: phoneCheck }, []);

/** @param {unknown} v */
const linesCheck = (v) => {
	if (!Array.isArray(v) || v.length === 0 || v.length > 100) return 'items_invalid';
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const [index, line] of v.entries())
		problems.push(
			...checkFields(
				line,
				{
					itemId: idCheck,
					variantId: idCheck,
					sku: (x) => (typeof x === 'string' && x.length <= 100 ? null : 'text_invalid'),
					title: (x) => (typeof x === 'string' && x.length <= 300 ? null : 'text_invalid'),
				},
				['itemId'],
				`/${index}`,
			),
		);
	return problems;
};

/**
 * `POST /v1/review-requests` — a request for an order completed outside the Event Hub.
 * @param {unknown} body
 */
export const validateRequestInput = (body) =>
	checkFields(
		body,
		{
			orderId: idCheck,
			customerId: customerCheck,
			number: (v) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? null : 'text_invalid'),
			contact: contactCheck,
			items: linesCheck,
			completedAt: dateCheck,
			locale: localeCheck,
		},
		['orderId', 'customerId', 'items'],
	);

/**
 * `POST /v1/moderation/{id}/reject`.
 * @param {unknown} body
 * @param {readonly string[]} reasons
 */
export const validateReject = (body, reasons) =>
	checkFields(
		body,
		{ reason: (v) => (typeof v === 'string' && reasons.includes(v) ? null : 'reason_invalid'), note: textCheck({ max: 500 }) },
		['reason'],
	);

/**
 * `POST /v1/moderation/{id}/approve` (optional note).
 * @param {unknown} body
 */
export const validateApprove = (body) => checkFields(body ?? {}, { note: textCheck({ max: 500 }) }, []);

/**
 * `POST /v1/moderation/{id}/reply`.
 * @param {unknown} body
 * @param {number} maxLength
 */
export const validateReply = (body, maxLength) => checkFields(body, { body: textCheck({ max: maxLength }) }, ['body']);

/**
 * `POST /v1/questions`.
 * @param {unknown} body
 * @param {{ maxLength: number, server: boolean }} options
 */
export const validateQuestion = (body, { maxLength, server }) =>
	checkFields(
		body,
		{
			itemId: idCheck,
			body: textCheck({ min: 3, max: maxLength }),
			author: (v) => checkFields(v, { name: nameCheck(120), email: emailCheck }, []),
			locale: localeCheck,
			...(server ? { customerId: customerCheck } : {}),
		},
		['itemId', 'body'],
	);

/**
 * `POST /v1/questions/{id}/answers`.
 * @param {unknown} body
 * @param {{ maxLength: number, server: boolean }} options
 */
export const validateAnswer = (body, { maxLength, server }) =>
	checkFields(
		body,
		{
			body: textCheck({ max: maxLength }),
			author: (v) => checkFields(v, { name: nameCheck(120) }, []),
			...(server ? { customerId: customerCheck } : {}),
		},
		['body'],
	);

/**
 * `POST /v1/review-photos` — an upload slot.
 * @param {unknown} body
 * @param {{ allowedTypes: readonly string[], maxBytes: number, server: boolean }} options
 */
export const validatePhotoUpload = (body, { allowedTypes, maxBytes, server }) =>
	checkFields(
		body,
		{
			contentType: (v) => (typeof v === 'string' && allowedTypes.includes(v) ? null : 'type_not_allowed'),
			size: (v) =>
				Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= maxBytes
					? null
					: 'size_invalid',
			...(server
				? { customerId: customerCheck }
				: { token: (v) => (typeof v === 'string' && v.length <= 2048 ? null : 'token_invalid') }),
		},
		['contentType', 'size'],
	);

/**
 * `POST /v1/imports`.
 * @param {unknown} body
 */
export const validateImport = (body) =>
	checkFields(body, { csv: (v) => (typeof v === 'string' && v.length > 0 ? null : 'csv_invalid'), dryRun: boolCheck }, ['csv']);

/**
 * `POST /v1/moderation:check` — a condition to check and/or a sample review to run through moderation.
 * @param {unknown} body
 */
export const validateModerationCheck = (body) => {
	const problems = checkFields(
		body,
		{
			source: (v) => (typeof v === 'string' && v.length <= 4000 ? null : 'text_invalid'),
			review: (v) => (isObject(v) ? null : 'object_invalid'),
		},
		[],
	);
	if (problems.length === 0 && isObject(body) && body.source === undefined && body.review === undefined)
		problems.push({ path: '/source', code: 'required' });
	return problems;
};

/**
 * `POST /v1/review-requests:open` — resolve a review link token.
 * @param {unknown} body
 */
export const validateToken = (body) =>
	checkFields(body, { token: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 2048 ? null : 'token_invalid') }, [
		'token',
	]);
