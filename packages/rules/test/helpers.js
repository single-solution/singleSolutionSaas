import { compile, evaluate } from '../src/index.js';

export const NOW = '2026-10-01T12:00:00Z';

/**
 * Compile (asserting success) and return the program.
 * @param {string} source
 * @param {import('../src/compile.js').CompileOptions} [options]
 */
export function prog(source, options) {
	const r = compile(source, options);
	if (!r.ok) throw new Error(`compile failed for ${source}: ${r.error.message}`);
	return r.program;
}

/**
 * Compile + evaluate; returns the value (throws on any error so tests fail loudly).
 * @param {string} source
 * @param {unknown} [context]
 * @param {import('../src/evaluate.js').EvaluateOptions} [options]
 * @returns {unknown}
 */
export function run(source, context = {}, options = {}) {
	const r = evaluate(prog(source), context, { now: NOW, ...options });
	if (!r.ok) throw new Error(`evaluate failed for ${source}: ${r.error.message}`);
	return r.value;
}

/**
 * Compile error for a source (asserts failure).
 * @param {string} source
 * @param {import('../src/compile.js').CompileOptions} [options]
 */
export function compileError(source, options) {
	const r = compile(source, options);
	if (r.ok) throw new Error(`expected compile error for ${source}`);
	return r.error;
}

/**
 * Evaluation error (asserts failure).
 * @param {string} source
 * @param {unknown} [context]
 * @param {import('../src/evaluate.js').EvaluateOptions} [options]
 */
export function evalError(source, context = {}, options = {}) {
	const r = evaluate(prog(source), context, { now: NOW, ...options });
	if (r.ok) throw new Error(`expected evaluation error for ${source}`);
	return r.error;
}
