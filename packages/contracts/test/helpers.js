import { expect } from 'vitest';

/**
 * Assert a failed result contains a problem with the given path (and keyword when given).
 * @param {{ ok: boolean, problems?: ReadonlyArray<{ path: string, keyword: string, message: string }> }} result
 * @param {string} path
 * @param {string} [keyword]
 */
export const expectProblem = (result, path, keyword) => {
	expect(result.ok).toBe(false);
	const problems = result.problems ?? [];
	const match = problems.find((problem) => problem.path === path && (keyword === undefined || problem.keyword === keyword));
	expect(match, `expected problem at ${path} (${keyword ?? 'any'}); got ${JSON.stringify(problems)}`).toBeDefined();
};

/**
 * Assert a problem list (semantic checks) contains a rule at a path.
 * @param {ReadonlyArray<{ path: string, keyword: string }>} problems
 * @param {string} keyword
 * @param {string} [path]
 */
export const expectRule = (problems, keyword, path) => {
	const match = problems.find((problem) => problem.keyword === keyword && (path === undefined || problem.path === path));
	expect(match, `expected rule ${keyword} at ${path ?? 'any'}; got ${JSON.stringify(problems)}`).toBeDefined();
};
