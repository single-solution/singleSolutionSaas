/**
 * NDJSON files: one JSON record per line. The files `read` writes hold every record of a step; `send` cuts them into
 * calls that fit the products' import routes (`@ss/contracts` `IMPORT_LIMITS`: at most 1,000 records and 4 MB).
 * @module
 */
import { IMPORT_LIMITS } from '@ss/contracts';

/**
 * NDJSON text of records (with a final newline).
 * @param {ReadonlyArray<unknown>} records
 */
export const toNdjson = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join('');

/**
 * The lines of an NDJSON text, with their line numbers (empty lines skipped).
 * @param {string} text
 * @returns {Array<{ line: number, text: string }>}
 */
export const linesOf = (text) =>
	text
		.split('\n')
		.map((line, index) => ({ line: index + 1, text: line.trim() }))
		.filter((entry) => entry.text !== '');

/**
 * Cut NDJSON lines into calls of at most `records` lines and `bytes` bytes; each call keeps the file line of its first
 * line, so failures map back to the file.
 * @param {Array<{ line: number, text: string }>} lines
 * @param {{ records?: number, bytes?: number }} [limits]
 * @returns {Array<{ firstLine: number, lines: number[], body: string }>}
 */
export const chunk = (lines, { records = IMPORT_LIMITS.records, bytes = IMPORT_LIMITS.bytes } = {}) => {
	/** @type {Array<{ firstLine: number, lines: number[], body: string }>} */
	const calls = [];
	/** @type {{ firstLine: number, lines: number[], parts: string[], size: number } | null} */
	let current = null;
	for (const { line, text } of lines) {
		const size = Buffer.byteLength(text) + 1;
		if (size > bytes) throw new RangeError(`line ${line} is larger than one import call (${bytes} bytes)`);
		if (current && (current.lines.length >= records || current.size + size > bytes)) {
			calls.push({ firstLine: current.firstLine, lines: current.lines, body: `${current.parts.join('\n')}\n` });
			current = null;
		}
		current ??= { firstLine: line, lines: [], parts: [], size: 0 };
		current.lines.push(line);
		current.parts.push(text);
		current.size += size;
	}
	if (current) calls.push({ firstLine: current.firstLine, lines: current.lines, body: `${current.parts.join('\n')}\n` });
	return calls;
};
