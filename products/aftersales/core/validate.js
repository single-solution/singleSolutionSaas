/**
 * Input validation (pure): every API body is checked and capped here before anything else runs. Validators return
 * field problems `{ path, code }` (JSON Pointer paths) and, when valid, the cleaned value.
 * @module
 */
import { linesOf } from './purchases.js';
import { cleanText, isId, isKey, isObject, normalEmail, normalPhone } from './text.js';
import { toMs } from './time.js';

/** @typedef {{ path: string, code: string }} FieldProblem */
/**
 * @template T
 * @typedef {{ problems: FieldProblem[], value: T | null }} Checked
 */

/** Largest claim token accepted. */
const TOKEN_MAX = 1024;
/** Lines per purchase in the API. */
const PURCHASE_LINES_MAX = 500;
/** Photos per claim in any configuration. */
const PHOTOS_MAX = 10;

/**
 * @param {FieldProblem[]} problems
 * @param {unknown} value
 * @param {string} path
 * @param {number} max
 * @param {{ required?: boolean, min?: number }} [options]
 */
const checkText = (problems, value, path, max, { required = false, min = 0 } = {}) => {
	if (value === undefined || value === null || value === '') {
		if (required) problems.push({ path, code: 'required' });
		return;
	}
	if (typeof value !== 'string') problems.push({ path, code: 'invalid' });
	else if (cleanText(value).length > max) problems.push({ path, code: 'too_long' });
	else if (cleanText(value).length < min) problems.push({ path, code: 'too_short' });
};

/**
 * @param {FieldProblem[]} problems
 * @param {unknown} value
 * @param {string} path
 * @param {{ required?: boolean }} [options]
 */
const checkId = (problems, value, path, { required = false } = {}) => {
	if (value === undefined || value === null) {
		if (required) problems.push({ path, code: 'required' });
	} else if (!isId(value)) problems.push({ path, code: 'id_invalid' });
};

/** @param {unknown} body */
const objectProblems = (body) => (isObject(body) ? [] : [{ path: '', code: 'invalid' }]);

/**
 * `POST /v1/purchases`: a purchase registered by the merchant's server (no order events, or extra data).
 * @param {unknown} body
 */
export const validatePurchase = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkId(problems, input.orderId, '/orderId');
	checkText(problems, input.reference, '/reference', 120);
	checkText(problems, input.number, '/number', 64);
	checkId(problems, input.customerId, '/customerId');
	if (input.customer !== undefined) {
		if (!isObject(input.customer)) problems.push({ path: '/customer', code: 'invalid' });
		else {
			checkId(problems, input.customer.customerId, '/customer/customerId');
			checkText(problems, input.customer.subject, '/customer/subject', 255);
			checkText(problems, input.customer.name, '/customer/name', 120);
			if (input.customer.email !== undefined && normalEmail(input.customer.email) === null)
				problems.push({ path: '/customer/email', code: 'invalid' });
			if (input.customer.phone !== undefined && normalPhone(input.customer.phone) === null)
				problems.push({ path: '/customer/phone', code: 'invalid' });
		}
	}
	if (input.currency !== undefined && !(typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency)))
		problems.push({ path: '/currency', code: 'invalid' });
	if (input.total !== undefined && !(Number.isInteger(input.total) && input.total >= 0))
		problems.push({ path: '/total', code: 'invalid' });
	for (const field of ['placedAt', 'deliveredAt'])
		if (input[field] !== undefined && input[field] !== null && toMs(input[field]) === null)
			problems.push({ path: `/${field}`, code: 'invalid' });
	if (!Array.isArray(input.lines) || input.lines.length === 0) problems.push({ path: '/lines', code: 'required' });
	else if (input.lines.length > PURCHASE_LINES_MAX) problems.push({ path: '/lines', code: 'too_many' });
	else
		for (const [index, line] of input.lines.entries()) {
			const path = `/lines/${index}`;
			if (!isObject(line)) {
				problems.push({ path, code: 'invalid' });
				continue;
			}
			checkId(problems, line.itemId, `${path}/itemId`, { required: true });
			checkId(problems, line.variantId, `${path}/variantId`);
			checkId(problems, line.lineId, `${path}/lineId`);
			checkText(problems, line.sku, `${path}/sku`, 100);
			checkText(problems, line.title, `${path}/title`, 300);
			checkText(problems, line.grade, `${path}/grade`, 40);
			if (!(Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 1_000_000))
				problems.push({ path: `${path}/quantity`, code: 'invalid' });
			if (line.unitAmount !== undefined && !(Number.isInteger(line.unitAmount) && line.unitAmount >= 0))
				problems.push({ path: `${path}/unitAmount`, code: 'invalid' });
			if (line.itemType !== undefined && !isKey(line.itemType)) problems.push({ path: `${path}/itemType`, code: 'invalid' });
			if (line.warrantyDays !== undefined && !(Number.isInteger(line.warrantyDays) && line.warrantyDays >= 0))
				problems.push({ path: `${path}/warrantyDays`, code: 'invalid' });
			if (line.serials !== undefined) {
				if (!Array.isArray(line.serials) || line.serials.length > 1000)
					problems.push({ path: `${path}/serials`, code: 'invalid' });
				else if (line.serials.some((/** @type {unknown} */ serial) => typeof serial !== 'string' || serial.length > 128))
					problems.push({ path: `${path}/serials`, code: 'invalid' });
			}
		}
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			orderId: input.orderId ?? null,
			reference: input.reference ? cleanText(input.reference) : null,
			number: input.number ? cleanText(input.number) : null,
			currency: input.currency ?? null,
			total: input.total ?? null,
			placedAt: input.placedAt ? toMs(input.placedAt) : null,
			deliveredAt: input.deliveredAt === undefined ? undefined : input.deliveredAt === null ? null : toMs(input.deliveredAt),
			lines: linesOf(input.lines),
			serials: /** @type {Array<{ itemId: string, variantId: string | null, serial: string }>} */ (
				input.lines.flatMap((/** @type {any} */ line) =>
					(line.serials ?? []).map((/** @type {string} */ serial) => ({
						itemId: line.itemId,
						variantId: line.variantId ?? null,
						serial,
					})),
				)
			),
			raw: { customer: input.customer, customerId: input.customerId },
		},
	};
};

/**
 * `POST /v1/claim-access`: a guest proves a purchase with its order number (or id) and the e-mail or phone used.
 * @param {unknown} body
 */
export const validateAccess = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkText(problems, input.number, '/number', 64);
	checkId(problems, input.orderId, '/orderId');
	if (!input.number && !input.orderId) problems.push({ path: '/number', code: 'required' });
	const email = input.email === undefined ? null : normalEmail(input.email);
	const phone = input.phone === undefined ? null : normalPhone(input.phone);
	if (input.email !== undefined && email === null) problems.push({ path: '/email', code: 'invalid' });
	if (input.phone !== undefined && phone === null) problems.push({ path: '/phone', code: 'invalid' });
	if (input.email === undefined && input.phone === undefined) problems.push({ path: '/email', code: 'required' });
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: { number: input.number ? cleanText(input.number) : null, orderId: input.orderId ?? null, email, phone },
	};
};

/**
 * @param {FieldProblem[]} problems
 * @param {unknown} token
 * @param {{ required?: boolean }} [options]
 */
const checkToken = (problems, token, { required = false } = {}) => {
	if (token === undefined || token === null) {
		if (required) problems.push({ path: '/token', code: 'required' });
	} else if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX)
		problems.push({ path: '/token', code: 'invalid' });
};

/**
 * `POST /v1/claims`.
 * @param {unknown} body
 * @param {{ detailsMax: number, linesMax: number }} limits
 * @returns {Checked<import('./claims.js').ClaimInput & { token: string | null }>}
 */
export const validateClaim = (body, { detailsMax, linesMax }) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkId(problems, input.purchaseId, '/purchaseId', { required: true });
	if (!isKey(input.type)) problems.push({ path: '/type', code: input.type === undefined ? 'required' : 'invalid' });
	if (!isKey(input.reason)) problems.push({ path: '/reason', code: input.reason === undefined ? 'required' : 'invalid' });
	checkText(problems, input.details, '/details', detailsMax);
	checkToken(problems, input.token);
	if (!Array.isArray(input.lines) || input.lines.length === 0) problems.push({ path: '/lines', code: 'required' });
	else if (input.lines.length > linesMax) problems.push({ path: '/lines', code: 'too_many' });
	else
		for (const [index, line] of input.lines.entries()) {
			const path = `/lines/${index}`;
			if (!isObject(line)) {
				problems.push({ path, code: 'invalid' });
				continue;
			}
			checkId(problems, line.lineId, `${path}/lineId`, { required: true });
			if (!(Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 1_000_000))
				problems.push({ path: `${path}/quantity`, code: 'invalid' });
			checkText(problems, line.serial, `${path}/serial`, 128);
		}
	if (input.photoIds !== undefined) {
		if (!Array.isArray(input.photoIds) || input.photoIds.length > PHOTOS_MAX)
			problems.push({ path: '/photoIds', code: 'invalid' });
		else if (new Set(input.photoIds).size !== input.photoIds.length || input.photoIds.some((id) => !isId(id)))
			problems.push({ path: '/photoIds', code: 'invalid' });
	}
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			purchaseId: input.purchaseId,
			type: input.type,
			reason: input.reason,
			details: cleanText(input.details),
			lines: input.lines.map((/** @type {any} */ line) => ({
				lineId: line.lineId,
				quantity: line.quantity,
				serial: typeof line.serial === 'string' && line.serial.trim() !== '' ? line.serial : null,
			})),
			photoIds: input.photoIds ?? [],
			token: input.token ?? null,
		},
	};
};

/**
 * `POST /v1/claims:view` (guests): the claim token and optionally one claim.
 * @param {unknown} body
 */
export const validateView = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkToken(problems, input.token, { required: true });
	checkId(problems, input.claimId, '/claimId');
	return problems.length > 0
		? { problems, value: null }
		: { problems, value: { token: input.token, claimId: input.claimId ?? null } };
};

/**
 * `POST /v1/claim-photos`: an upload slot for one photo.
 * @param {unknown} body
 * @param {{ allowedTypes: string[], maxBytes: number }} limits
 */
export const validatePhotoUpload = (body, { allowedTypes, maxBytes }) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	if (typeof input.contentType !== 'string' || !allowedTypes.includes(input.contentType))
		problems.push({ path: '/contentType', code: 'type_not_allowed' });
	if (!Number.isInteger(input.size) || input.size < 1) problems.push({ path: '/size', code: 'invalid' });
	else if (input.size > maxBytes) problems.push({ path: '/size', code: 'too_large' });
	checkToken(problems, input.token);
	return problems.length > 0
		? { problems, value: null }
		: { problems, value: { contentType: input.contentType, size: input.size, token: input.token ?? null } };
};

/**
 * `POST /v1/queue/{id}/transition`.
 * @param {unknown} body
 * @param {number} noteMax
 */
export const validateTransition = (body, noteMax) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	if (!isKey(input.to)) problems.push({ path: '/to', code: input.to === undefined ? 'required' : 'invalid' });
	checkText(problems, input.note, '/note', noteMax);
	return problems.length > 0 ? { problems, value: null } : { problems, value: { to: input.to, note: cleanText(input.note) } };
};

/**
 * `POST /v1/queue/{id}/notes` and messages: a non-empty text.
 * @param {unknown} body
 * @param {number} max
 */
export const validateNote = (body, max) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkText(problems, input.body, '/body', max, { required: true, min: 1 });
	return problems.length > 0 ? { problems, value: null } : { problems, value: { body: cleanText(input.body) } };
};

/**
 * `POST /v1/queue/{id}/assign`: an assignee (opaque id or name) or null to unassign.
 * @param {unknown} body
 */
export const validateAssign = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	if (input.assignee !== null) checkText(problems, input.assignee, '/assignee', 120, { required: true });
	return problems.length > 0
		? { problems, value: null }
		: { problems, value: { assignee: input.assignee === null ? null : cleanText(input.assignee) } };
};

/**
 * `POST /v1/refunds`.
 * @param {unknown} body
 */
export const validateRefund = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkId(problems, input.claimId, '/claimId', { required: true });
	if (!(Number.isSafeInteger(input.amount) && input.amount >= 1)) problems.push({ path: '/amount', code: 'invalid' });
	if (!isKey(input.method)) problems.push({ path: '/method', code: input.method === undefined ? 'required' : 'invalid' });
	checkText(problems, input.reference, '/reference', 200);
	checkText(problems, input.note, '/note', 500);
	return problems.length > 0
		? { problems, value: null }
		: {
				problems,
				value: {
					claimId: input.claimId,
					amount: input.amount,
					method: input.method,
					reference: input.reference ? cleanText(input.reference) : null,
					note: input.note ? cleanText(input.note) : null,
				},
			};
};

/**
 * `POST /v1/restocks`.
 * @param {unknown} body
 */
export const validateRestock = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkId(problems, input.claimId, '/claimId', { required: true });
	if (!Array.isArray(input.lines) || input.lines.length === 0) problems.push({ path: '/lines', code: 'required' });
	else if (input.lines.length > 100) problems.push({ path: '/lines', code: 'too_many' });
	else
		for (const [index, line] of input.lines.entries()) {
			if (!isObject(line) || !isId(line.lineId) || typeof line.restock !== 'boolean')
				problems.push({ path: `/lines/${index}`, code: 'invalid' });
		}
	return problems.length > 0
		? { problems, value: null }
		: {
				problems,
				value: {
					claimId: input.claimId,
					lines: input.lines.map((/** @type {any} */ line) => ({ lineId: line.lineId, restock: line.restock })),
				},
			};
};

/**
 * `POST /v1/serials`.
 * @param {unknown} body
 */
export const validateSerial = (body) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkText(problems, input.serial, '/serial', 128, { required: true });
	checkId(problems, input.itemId, '/itemId', { required: true });
	checkId(problems, input.variantId, '/variantId');
	checkId(problems, input.orderId, '/orderId');
	checkId(problems, input.purchaseId, '/purchaseId');
	checkText(problems, input.title, '/title', 300);
	if (input.soldAt !== undefined && toMs(input.soldAt) === null) problems.push({ path: '/soldAt', code: 'invalid' });
	return problems.length > 0
		? { problems, value: null }
		: {
				problems,
				value: {
					serial: String(input.serial),
					itemId: input.itemId,
					variantId: input.variantId ?? null,
					orderId: input.orderId ?? null,
					purchaseId: input.purchaseId ?? null,
					title: input.title ? cleanText(input.title) : null,
					soldAt: input.soldAt ? toMs(input.soldAt) : null,
				},
			};
};

/**
 * `POST /v1/messages`.
 * @param {unknown} body
 * @param {number} max
 */
export const validateMessage = (body, max) => {
	const problems = objectProblems(body);
	if (problems.length > 0) return { problems, value: null };
	const input = /** @type {Record<string, any>} */ (body);
	checkId(problems, input.claimId, '/claimId', { required: true });
	checkText(problems, input.body, '/body', max, { required: true, min: 1 });
	checkToken(problems, input.token);
	return problems.length > 0
		? { problems, value: null }
		: { problems, value: { claimId: input.claimId, body: cleanText(input.body), token: input.token ?? null } };
};
