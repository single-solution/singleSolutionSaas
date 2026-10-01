/**
 * Problem replies shared by the route handlers: field problems → RFC 9457 `validation_failed`, service failures →
 * their stable problem codes (product codes are declared in adapters/platform.js `PROBLEM_CODES`).
 */
import { problem } from '@ss/app-kit';

/**
 * @param {Array<{ path: string, code: string }>} problems
 */
export const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })),
	});

/**
 * Map a service failure to a problem.
 * @param {any} result `{ reason, problems? }`
 */
export const failed = (result) => {
	const reason = String(result?.reason ?? 'internal_error');
	if (reason === 'validation_failed') return invalid(result.problems ?? []);
	if (reason === 'not_found') return problem('not_found', 'Not found.');
	return problem(reason, reason.replace(/_/g, ' '));
};
