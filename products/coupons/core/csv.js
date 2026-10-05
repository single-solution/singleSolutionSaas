/**
 * CSV export (pure): RFC 4180 quoting with CRLF line ends, and spreadsheet formula injection neutralised (cells that
 * start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`), so an exported code list is safe to open anywhere.
 * @module
 */

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA = /^[=+\-@\t\r]/;

/**
 * One CSV cell.
 * @param {unknown} value
 * @returns {string}
 */
export const csvCell = (value) => {
	if (value === null || value === undefined) return '';
	let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
	if (FORMULA.test(text)) text = `'${text}`;
	return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A CSV document with a header row.
 * @param {readonly string[]} columns
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {string}
 */
export const toCsv = (columns, rows) =>
	[columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))]
		.map((line) => `${line}\r\n`)
		.join('');
