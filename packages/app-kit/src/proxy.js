/**
 * Next.js proxy for products: while the environment is misconfigured (e.g. `MONGODB_URI` missing in production)
 * every request — pages included — answers 503 with `{ status: 'misconfigured', problems }`; otherwise the request
 * continues. A product's `proxy.js` re-exports it: `export { proxy } from '@ss/app-kit/proxy';`.
 * @module
 */
import { configProblems } from './env.js';
import { misconfiguredResponse } from './misconfigured.js';

/**
 * Next.js calls it with the request; the answer depends on the environment only.
 * @returns {Response | undefined}
 */
export const proxy = () => {
	const problems = configProblems(process.env);
	return problems.length > 0 ? misconfiguredResponse(problems) : undefined;
};
