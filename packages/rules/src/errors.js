/**
 * Error helpers. Internally the lexer, parser and evaluator throw `Error`s tagged with a `code` (and, for compile errors,
 * a source `offset`); the public API catches them and returns plain `RuleError` objects — it never throws.
 */

/**
 * @typedef {object} RuleError
 * @property {string} code Machine-readable code, e.g. `syntax`, `unknown_function`, `max_steps`.
 * @property {string} message Human-readable message suitable for an editor or log.
 * @property {number} [line] 1-based line (compile errors only).
 * @property {number} [column] 1-based column in UTF-16 code units (compile errors only).
 * @property {number} [offset] 0-based source offset (compile errors only).
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {number} [offset]
 * @returns {Error & { code: string, offset: number | undefined }}
 */
export function ruleError(code, message, offset) {
	return Object.assign(new Error(message), { code, offset });
}

/**
 * @param {string} source
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
export function positionOf(source, offset) {
	let line = 1;
	let column = 1;
	const end = Math.min(offset, source.length);
	for (let i = 0; i < end; i++) {
		if (source.charCodeAt(i) === 10) {
			line++;
			column = 1;
		} else column++;
	}
	return { line, column };
}

/**
 * Convert anything caught into a `RuleError`. Unknown failures become `internal` (never leaks a stack).
 * @param {unknown} err
 * @param {string} [source] When given and the error carries an offset, line/column are attached.
 * @returns {RuleError}
 */
export function toRuleError(err, source) {
	if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
		/** @type {RuleError} */
		const out = { code: err.code, message: err.message };
		const offset = 'offset' in err ? err.offset : undefined;
		if (typeof offset === 'number' && source !== undefined) {
			const { line, column } = positionOf(source, offset);
			out.line = line;
			out.column = column;
			out.offset = offset;
		}
		return out;
	}
	if (err instanceof RangeError) return { code: 'internal', message: 'Evaluation failed: stack or range limit exceeded' };
	return { code: 'internal', message: 'Evaluation failed unexpectedly' };
}
