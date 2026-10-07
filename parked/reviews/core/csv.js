/**
 * CSV import (pure): an RFC 4180 parser (quoted fields, doubled quotes, CR/LF/CRLF line ends, a leading BOM) and the
 * mapping of rows to reviews with per-row validation. Column names come from `import.columns`, so exports of other
 * platforms can be mapped without editing the file. Imported text gets the same sanitation as submitted text.
 * @module
 */
import { sanitizeText, singleLine } from './text.js';
import { CUSTOMER_PATTERN, ID_PATTERN } from './validate.js';

/**
 * Parse CSV text into rows of fields.
 * @param {string} text
 * @param {{ delimiter?: string, maxRows?: number }} [options] `maxRows` counts every row including the header
 * @returns {{ ok: true, rows: string[][] } | { ok: false, code: 'unterminated_quote' | 'too_many_rows' | 'empty', line: number }}
 */
export const parseCsv = (text, { delimiter = ',', maxRows = Number.MAX_SAFE_INTEGER } = {}) => {
	const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
	/** @type {string[][]} */
	const rows = [];
	/** @type {string[]} */
	let row = [];
	let field = '';
	let quoted = false;
	let line = 1;
	let quoteLine = 1;
	let i = 0;
	const endRow = () => {
		row.push(field);
		field = '';
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
	};
	while (i < source.length) {
		const char = source[i];
		if (quoted) {
			if (char === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i += 1;
				continue;
			}
			if (char === '\n') line += 1;
			field += char;
			i += 1;
			continue;
		}
		if (char === '"' && field === '') {
			quoted = true;
			quoteLine = line;
			i += 1;
		} else if (char === delimiter) {
			row.push(field);
			field = '';
			i += 1;
		} else if (char === '\r' || char === '\n') {
			endRow();
			if (rows.length > maxRows) return { ok: false, code: 'too_many_rows', line };
			i += char === '\r' && source[i + 1] === '\n' ? 2 : 1;
			line += 1;
		} else {
			field += char;
			i += 1;
		}
	}
	if (quoted) return { ok: false, code: 'unterminated_quote', line: quoteLine };
	if (field !== '' || row.length > 0) endRow();
	if (rows.length > maxRows) return { ok: false, code: 'too_many_rows', line };
	if (rows.length === 0) return { ok: false, code: 'empty', line: 1 };
	return { ok: true, rows };
};

/** Import fields and their default column names (`import.columns`). */
export const IMPORT_FIELDS = Object.freeze(
	/** @type {const} */ ([
		'item_id',
		'rating',
		'title',
		'body',
		'author',
		'submitted_at',
		'verified',
		'external_id',
		'reply',
		'order_id',
		'customer_id',
	]),
);

/**
 * @typedef {object} ImportRecord
 * @property {number} row 1-based line of the file (the header is row 1)
 * @property {string} itemId
 * @property {number} rating
 * @property {string | null} title
 * @property {string | null} body
 * @property {string | null} author
 * @property {string | null} submittedAt ISO
 * @property {boolean} verified
 * @property {string | null} externalId
 * @property {string | null} reply
 * @property {string | null} orderId
 * @property {string | null} customerId
 */

const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0', '']);

/**
 * Map parsed rows to review records; invalid rows are reported, never half-imported.
 * @param {string[][]} rows header first
 * @param {{ columns: Record<string, string>, scale: number, titleMax: number, bodyMax: number, authorMax: number,
 *   trustVerified: boolean, now: number }} options
 * @returns {{ records: ImportRecord[], errors: Array<{ row: number, path: string, code: string }> }}
 */
export const mapImportRows = (rows, { columns, scale, titleMax, bodyMax, authorMax, trustVerified, now }) => {
	const [header = [], ...body] = rows;
	const index = new Map(header.map((name, position) => [name.trim().toLowerCase(), position]));
	/** @param {string} field */
	const columnOf = (field) =>
		index.get(
			String(columns[field] ?? field)
				.trim()
				.toLowerCase(),
		);
	/** @type {Array<{ row: number, path: string, code: string }>} */
	const errors = [];
	for (const field of ['item_id', 'rating'])
		if (columnOf(field) === undefined) errors.push({ row: 1, path: `/${field}`, code: 'column_missing' });
	if (errors.length > 0) return { records: [], errors };
	/** @type {ImportRecord[]} */
	const records = [];
	for (const [offset, cells] of body.entries()) {
		const row = offset + 2;
		/** @param {string} field */
		const cell = (field) => {
			const at = columnOf(field);
			return at === undefined ? '' : (cells[at] ?? '').trim();
		};
		/** @type {Array<{ row: number, path: string, code: string }>} */
		const rowErrors = [];
		const fail = (/** @type {string} */ field, /** @type {string} */ code) => rowErrors.push({ row, path: `/${field}`, code });
		const itemId = cell('item_id');
		if (!ID_PATTERN.test(itemId)) fail('item_id', 'id_invalid');
		const ratingText = cell('rating');
		const rating = /^\d{1,2}(?:\.0+)?$/.test(ratingText) ? Number(ratingText) : Number.NaN;
		if (!(Number.isInteger(rating) && rating >= 1 && rating <= scale)) fail('rating', 'rating_invalid');
		const rawTitle = cell('title');
		const title = singleLine(rawTitle, titleMax + 1);
		if (title.length > titleMax) fail('title', 'too_long');
		const rawBody = cell('body');
		const text = sanitizeText(rawBody, bodyMax + 1);
		if (text.length > bodyMax) fail('body', 'too_long');
		const author = singleLine(cell('author'), authorMax);
		const dateText = cell('submitted_at');
		const submittedMs = dateText ? Date.parse(dateText) : Number.NaN;
		if (dateText && !(Number.isFinite(submittedMs) && submittedMs <= now)) fail('submitted_at', 'date_invalid');
		const verifiedText = cell('verified').toLowerCase();
		if (!TRUE.has(verifiedText) && !FALSE.has(verifiedText)) fail('verified', 'boolean_invalid');
		const externalId = cell('external_id');
		if (externalId && !ID_PATTERN.test(externalId)) fail('external_id', 'id_invalid');
		const orderId = cell('order_id');
		if (orderId && !ID_PATTERN.test(orderId)) fail('order_id', 'id_invalid');
		const customerId = cell('customer_id');
		if (customerId && !CUSTOMER_PATTERN.test(customerId)) fail('customer_id', 'customer_invalid');
		if (rowErrors.length > 0) {
			errors.push(...rowErrors);
			continue;
		}
		records.push({
			row,
			itemId,
			rating,
			title: title || null,
			body: text || null,
			author: author || null,
			submittedAt: dateText ? new Date(submittedMs).toISOString() : null,
			verified: trustVerified && TRUE.has(verifiedText),
			externalId: externalId || null,
			reply: sanitizeText(cell('reply'), 5000) || null,
			orderId: orderId || null,
			customerId: customerId || null,
		});
	}
	return { records, errors };
};
