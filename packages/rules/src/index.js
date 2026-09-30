/**
 * @ss/rules — rules@1, the safe, pure, time-boxed expression language shared by every product.
 * See README.md for the normative language reference.
 */

export { compile, check, referencedPaths, functionsUsed, serialize, deserialize } from './compile.js';
export { evaluate, evaluateCondition, explain } from './evaluate.js';
export { format } from './format.js';
export { validateProgram } from './validate.js';
export { truthy } from './values.js';
export { DEFAULT_LIMITS } from './limits.js';
export { FUNCTION_LIST as FUNCTIONS, MAX_PATTERN_LENGTH } from './library.js';

/** The grammar version this package compiles and evaluates. */
export const LANGUAGE_VERSION = 1;

/**
 * @typedef {import('./ast.js').Program} Program
 * @typedef {import('./ast.js').Node} Node
 * @typedef {import('./errors.js').RuleError} RuleError
 * @typedef {import('./compile.js').CompileOptions} CompileOptions
 * @typedef {import('./compile.js').CompileResult} CompileResult
 * @typedef {import('./compile.js').CheckResult} CheckResult
 * @typedef {import('./evaluate.js').EvaluateOptions} EvaluateOptions
 * @typedef {import('./evaluate.js').EvaluateResult} EvaluateResult
 * @typedef {import('./evaluate.js').TraceFrame} TraceFrame
 * @typedef {import('./library.js').FunctionSpec} FunctionSpec
 */
