/**
 * The product's routes as written in `api/` (every `defineRoute({ … })` call, read statically): the source of
 * `openapi.json` and of the route checks of `ss app validate`.
 * @module
 */
import { problemOf } from './manifest.js';
import { findRoutes, lex } from './validate/scan.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./project.js').ProjectFiles} ProjectFiles */

/**
 * @typedef {object} ScannedRoute
 * @property {string} file
 * @property {number} line
 * @property {string} method
 * @property {string} path
 * @property {string} auth
 * @property {string} [feature]
 * @property {string} [permission]
 * @property {boolean} idempotent
 */

/** The generated widget module (`ss app assets`): it holds no route definitions. */
export const WIDGET_MODULE = 'api/widget-script.js';

/** Members that must be plain string literals so the route can be checked and documented. */
const LITERAL_MEMBERS = /** @type {const} */ (['method', 'path', 'auth', 'feature', 'permission']);

/**
 * Every route definition under `api/`. Definitions whose members cannot be read statically are reported
 * (`routes.dynamic`) and left out.
 * @param {ProjectFiles} files
 * @returns {Promise<{ routes: ScannedRoute[], problems: Problem[] }>}
 */
export const scanRoutes = async (files) => {
	/** @type {ScannedRoute[]} */
	const routes = [];
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		if (!file.startsWith('api/') || !file.endsWith('.js') || file === WIDGET_MODULE) continue;
		for (const { line, members, spread } of findRoutes(lex(await files.read(file)))) {
			const unreadable = LITERAL_MEMBERS.filter(
				(name) => (members[name] !== undefined || ['method', 'path', 'auth'].includes(name)) && !members[name]?.literal,
			);
			if (spread || unreadable.length > 0) {
				problems.push(
					problemOf({
						rule: 'routes.dynamic',
						file,
						line,
						message: `write ${spread ? 'the route without spreads and ' : ''}${(unreadable.length > 0 ? unreadable : ['method', 'path', 'auth']).join(', ')} as string literals so the route can be checked and documented`,
					}),
				);
				continue;
			}
			/** @param {string} name */
			const text = (name) => /** @type {string | undefined} */ (members[name]?.value);
			routes.push({
				file,
				line,
				method: /** @type {string} */ (text('method')),
				path: /** @type {string} */ (text('path')),
				auth: /** @type {string} */ (text('auth')),
				...(text('feature') === undefined ? {} : { feature: text('feature') }),
				...(text('permission') === undefined ? {} : { permission: text('permission') }),
				idempotent: members.idempotent?.value === true,
			});
		}
	}
	return { routes, problems };
};
