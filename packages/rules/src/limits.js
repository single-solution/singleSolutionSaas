/**
 * Security limits. Every limit is enforced with a distinct error code.
 */

export const DEFAULT_LIMITS = Object.freeze({
	/** Maximum source length in UTF-16 code units (`too_long`). */
	maxLength: 4000,
	/** Maximum AST / nesting depth (`too_deep`). Hard ceiling 256 regardless of options (stack safety). */
	maxDepth: 64,
	/** Maximum number of AST nodes (`too_many_nodes`). */
	maxNodes: 2000,
	/** Maximum evaluation steps per evaluate() call (`max_steps`). */
	maxSteps: 10000,
	/** Maximum length of any list the program produces: literals, filter(), map(), list + list (`list_too_long`). */
	maxListLength: 1000,
	/** Maximum length of any string the program produces by concatenation or string() (`string_too_long`). */
	maxStringLength: 10000,
});

const HARD_MAX_DEPTH = 256;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [ceiling]
 * @returns {number}
 */
export function limit(value, fallback, ceiling = Number.MAX_SAFE_INTEGER) {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

/**
 * @param {{ maxLength?: number, maxDepth?: number, maxNodes?: number }} [options]
 * @returns {{ maxLength: number, maxDepth: number, maxNodes: number }}
 */
export function compileLimits(options = {}) {
	return {
		maxLength: limit(options.maxLength, DEFAULT_LIMITS.maxLength),
		maxDepth: limit(options.maxDepth, DEFAULT_LIMITS.maxDepth, HARD_MAX_DEPTH),
		maxNodes: limit(options.maxNodes, DEFAULT_LIMITS.maxNodes),
	};
}
