/**
 * RFC 4180 CSV (pure). Writer: fields with the delimiter, `"`, CR or LF are quoted (quotes doubled); records end with
 * CRLF; text cells that start with `=`, `+`, `-`, `@`, TAB or CR get a leading `'` so spreadsheets never run them as
 * formulas (CSV injection); finite numbers are written as they are. Parser: quoted fields with delimiters, doubled
 * quotes and line breaks; CRLF, LF or CR record ends; a leading byte order mark is dropped; blank lines are skipped;
 * the writer's formula guard is reversed so a round trip is lossless.
 * @module
 */

/** Byte order mark spreadsheets need to open UTF-8. */
export const CSV_BOM = '\uFEFF';
const FORMULA = /^[=+\-@\t\r]/;

/** @typedef {string | number | boolean | null | undefined} Cell */

/**
 * One cell.
 * @param {Cell} value
 * @param {string} [delimiter]
 */
export const formatCell = (value, delimiter = ',') => {
	if (value === null || value === undefined) return '';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	const text = FORMULA.test(value) ? `'${value}` : value;
	return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A whole document.
 * @param {readonly string[]} header
 * @param {Iterable<readonly Cell[]>} rows
 * @param {{ delimiter?: string, bom?: boolean }} [options]
 */
export const toCsv = (header, rows, { delimiter = ',', bom = true } = {}) => {
	const line = (/** @type {readonly Cell[]} */ cells) =>
		`${cells.map((cell) => formatCell(cell, delimiter)).join(delimiter)}\r\n`;
	/** @type {string[]} */
	const out = [bom ? CSV_BOM : '', line(header)];
	for (const row of rows) out.push(line(row));
	return out.join('');
};

/**
 * Undo the writer's formula guard.
 * @param {string} value
 */
export const unescapeFormula = (value) =>
	value.length > 1 && value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value;

/**
 * Parse CSV text into rows.
 * @param {string} input
 * @param {{ delimiter?: string, maxRows?: number }} [options] `maxRows` counts data rows (the header excluded)
 * @returns {{ ok: true, rows: string[][] } | { ok: false, code: 'empty' | 'unterminated_quote' | 'too_many_rows' }}
 */
export const parseCsv = (input, { delimiter = ',', maxRows = Number.MAX_SAFE_INTEGER } = {}) => {
	const text = input.startsWith(CSV_BOM) ? input.slice(1) : input;
	/** @type {string[][]} */
	const rows = [];
	/** @type {string[]} */
	let row = [];
	let field = '';
	let quoted = false;
	let started = false;
	const endRow = () => {
		row.push(field);
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
		field = '';
		started = false;
	};
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else field += char;
			continue;
		}
		if (char === '"' && !started) {
			quoted = true;
			started = true;
		} else if (char === delimiter) {
			row.push(field);
			field = '';
			started = false;
		} else if (char === '\r' || char === '\n') {
			if (char === '\r' && text[index + 1] === '\n') index += 1;
			endRow();
			if (rows.length > maxRows + 1) return { ok: false, code: 'too_many_rows' };
		} else {
			field += char;
			started = true;
		}
	}
	if (quoted) return { ok: false, code: 'unterminated_quote' };
	if (started || field !== '' || row.length > 0) endRow();
	if (rows.length === 0) return { ok: false, code: 'empty' };
	if (rows.length > maxRows + 1) return { ok: false, code: 'too_many_rows' };
	return { ok: true, rows };
};

/**
 * Rows keyed by the (trimmed, lowercased) header; `line` is the 1-based record number (the header is line 1).
 * @param {string[][]} rows
 * @returns {{ header: string[], records: Array<{ line: number, values: Record<string, string> }> }}
 */
export const recordsOf = (rows) => {
	const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
	const records = rows.slice(1).map((cells, index) => {
		/** @type {Record<string, string>} */
		const values = {};
		header.forEach((key, column) => {
			if (key && !Object.hasOwn(values, key)) values[key] = unescapeFormula((cells[column] ?? '').trim());
		});
		return { line: index + 2, values };
	});
	return { header, records };
};
