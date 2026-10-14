/**
 * RFC 4180 CSV (pure), for the Redirects feature's import and export. Writer: comma-separated, a byte order mark first
 * (spreadsheets then open UTF-8), CRLF record ends, fields with a comma, `"`, CR or LF quoted (quotes doubled), and a
 * leading `'` on text that starts with `=`, `+`, `-`, `@`, TAB or CR so spreadsheets never run it as a formula (CSV
 * injection). Parser: the delimiter of the header line (comma, semicolon or tab, the one it holds most of), quoted
 * fields with delimiters, doubled quotes and line breaks, CRLF, LF or CR record ends, a leading byte order mark dropped,
 * blank lines skipped, and the writer's formula guard undone, so a round trip is lossless.
 * @module
 */

/** The byte order mark spreadsheets need to open UTF-8. */
const BOM = '﻿';
const FORMULA = /^[=+\-@\t\r]/;
/** The delimiters a file may use. */
const DELIMITERS = Object.freeze([',', ';', '\t']);

/**
 * One cell as written.
 * @param {string | number | null | undefined} value
 */
const cellOf = (value) => {
	if (value === null || value === undefined) return '';
	const text = typeof value === 'number' ? String(value) : FORMULA.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A whole file: the header, then one line per row.
 * @param {ReadonlyArray<string>} header
 * @param {Iterable<ReadonlyArray<string | number | null | undefined>>} rows
 */
export const toCsv = (header, rows) => {
	const out = [BOM, `${header.map(cellOf).join(',')}\r\n`];
	for (const row of rows) out.push(`${row.map(cellOf).join(',')}\r\n`);
	return out.join('');
};

/**
 * The delimiter of a file: the one its first line holds most of (comma when it holds none).
 * @param {string} text
 */
const delimiterOf = (text) => {
	const first = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
	/** @param {string} delimiter */
	const count = (delimiter) => first.split(delimiter).length;
	return DELIMITERS.reduce((best, delimiter) => (count(delimiter) > count(best) ? delimiter : best), ',');
};

/**
 * The formula guard of the writer, undone.
 * @param {string} value
 */
const unguarded = (value) => (value.length > 1 && value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value);

/**
 * Parse a file into records keyed by the header (trimmed, in lower case), each with its line number (the header is
 * line 1, so the first record is line 2).
 * @param {string} input
 * @param {{ maxRows: number }} options `maxRows`: most records (the header not counted)
 * @returns {{ ok: true, header: string[], records: Array<{ line: number, values: Record<string, string> }> }
 *   | { ok: false, code: 'empty' | 'unterminated_quote' | 'too_many_rows' }}
 */
export const parseCsv = (input, { maxRows }) => {
	const text = input.startsWith(BOM) ? input.slice(1) : input;
	const delimiter = delimiterOf(text);
	/** @type {string[][]} */
	const rows = [];
	/** @type {string[]} */
	let row = [];
	let field = '';
	let quoted = false;
	let started = false;
	const endRow = () => {
		row.push(field);
		if (!(row.length === 1 && row[0]?.trim() === '')) rows.push(row);
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
	const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
	// each named column once (its first), found once for every record: a header of many empty columns costs nothing
	/** @type {Map<string, number>} */
	const columns = new Map();
	header.forEach((key, column) => {
		if (key !== '' && !columns.has(key)) columns.set(key, column);
	});
	const records = rows.slice(1).map((cells, index) => {
		/** @type {Record<string, string>} */
		const values = {};
		for (const [key, column] of columns) values[key] = unguarded((cells[column] ?? '').trim());
		return { line: index + 2, values };
	});
	return { ok: true, header, records };
};
