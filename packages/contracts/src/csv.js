/**
 * CSV (RFC 4180) for every export and import (`@ss/contracts/csv`). Pure and browser-safe (no Node.js imports), so
 * servers and admin widgets write and read files the same way.
 *
 * Writer: a UTF-8 byte order mark first (spreadsheet apps then read names in any language right), CRLF after every
 * record, cells with the delimiter, `"`, CR or LF quoted (quotes doubled). Text that starts with `=`, `+`, `-`, `@`, TAB
 * or CR (after any leading `'`) gets one more leading `'`, so a spreadsheet never runs it as a formula (CSV
 * injection); numbers are written as numbers (`-12.5`, never guarded) and booleans as `true` / `false`.
 *
 * Parser: the delimiter given, else the one the first line holds most of (comma, semicolon or tab: spreadsheet apps in
 * many languages save with semicolons); quoted cells with delimiters, doubled quotes and line breaks; CRLF, LF or CR
 * record ends; a leading byte order mark dropped; blank lines skipped; the writer's formula guard undone, so a round
 * trip gives back every text as it was.
 * @module
 */

/** The byte order mark that tells spreadsheet apps a file is UTF-8. */
const BOM = '\uFEFF';
/** Text a spreadsheet would run as a formula (after any `'` the guard added before). */
const FORMULA = /^'*[=+\-@\t\r]/;
/** The delimiters a file read without one given may use. */
const DELIMITERS = Object.freeze([',', ';', '\t']);

/** @typedef {string | number | boolean | null | undefined} CsvCell */

/**
 * One cell as written: '' for null, undefined and numbers that are not finite.
 * @param {CsvCell} value
 * @param {string} [delimiter] `,` (default), `;` or TAB
 * @returns {string}
 */
export const csvCell = (value, delimiter = ',') => {
	if (value === null || value === undefined) return '';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	if (typeof value === 'boolean') return String(value);
	const text = FORMULA.test(value) ? `'${value}` : value;
	return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A whole file: the byte order mark, the header, then one record per row, each ending with CRLF.
 * @param {ReadonlyArray<CsvCell>} header
 * @param {Iterable<ReadonlyArray<CsvCell>>} rows
 * @param {{ delimiter?: string }} [options] `delimiter`: `,` (default), `;` or TAB
 * @returns {string}
 */
export const toCsv = (header, rows, { delimiter = ',' } = {}) => {
	/** @param {ReadonlyArray<CsvCell>} cells */
	const line = (cells) => `${cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)}\r\n`;
	const out = [BOM, line(header)];
	for (const row of rows) out.push(line(row));
	return out.join('');
};

/**
 * The delimiter of a file: the one its first line holds most of (comma when it holds none).
 * @param {string} text
 */
const delimiterOf = (text) => {
	const first = /** @type {string} */ (text.split(/\r\n|\r|\n/, 1)[0]);
	/** @param {string} delimiter */
	const count = (delimiter) => first.split(delimiter).length;
	return DELIMITERS.reduce((best, delimiter) => (count(delimiter) > count(best) ? delimiter : best), ',');
};

/**
 * A cell as read, the writer's formula guard undone.
 * @param {string} value
 */
const unguarded = (value) => (value.startsWith("'") && FORMULA.test(value) ? value.slice(1) : value);

/**
 * Parse a file into rows of cells (not trimmed; the formula guard undone).
 * @param {string} input
 * @param {{ delimiter?: string, maxRows?: number }} [options] `delimiter`: left out, the one the first line holds most
 *   of; `maxRows`: most records after the first (the header), none by default
 * @returns {{ ok: true, rows: string[][] } | { ok: false, code: 'empty' | 'unterminated_quote' | 'too_many_rows' }}
 */
export const parseCsv = (input, { delimiter, maxRows = Number.POSITIVE_INFINITY } = {}) => {
	const text = input.startsWith(BOM) ? input.slice(1) : input;
	const separator = delimiter ?? delimiterOf(text);
	/** @type {string[][]} */
	const rows = [];
	/** @type {string[]} */
	let row = [];
	let field = '';
	let quoted = false;
	let started = false;
	const endField = () => {
		row.push(unguarded(field));
		field = '';
		started = false;
	};
	const endRow = () => {
		endField();
		if (!(row.length === 1 && /** @type {string} */ (row[0]).trim() === '')) rows.push(row);
		row = [];
	};
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"' && !started) {
			quoted = true;
			started = true;
		} else if (char === separator) endField();
		else if (char === '\r' || char === '\n') {
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
 * Rows as records keyed by the header (each name trimmed and in lower case; a name used twice keeps its first column;
 * empty names are skipped), values trimmed. `line` is the record's number in the file: the header is line 1, so the
 * first record is line 2.
 * @param {ReadonlyArray<ReadonlyArray<string>>} rows from {@link parseCsv}
 * @returns {{ header: string[], records: Array<{ line: number, values: Record<string, string> }> }}
 */
export const csvRecords = (rows) => {
	const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
	/** Each named column once, found once for every record (many empty names cost nothing). @type {Map<string, number>} */
	const columns = new Map();
	header.forEach((key, column) => {
		if (key !== '' && !columns.has(key)) columns.set(key, column);
	});
	const records = rows.slice(1).map((cells, index) => ({
		line: index + 2,
		values: Object.fromEntries([...columns].map(([key, column]) => [key, (cells[column] ?? '').trim()])),
	}));
	return { header, records };
};
