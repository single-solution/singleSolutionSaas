/**
 * Boot a Portal with the config module and fakes on a MongoMemoryReplSet database.
 * @module
 */
import { createPortal } from '../../../src/portal.js';
import { configModule } from '../../../src/modules/config/index.js';
import { PORTAL_URL, createClock, createTestLogger, testConfig } from '../../helpers.js';
import { createFakes } from './fakes/index.js';

export const SAME_ORIGIN = { origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' };

/**
 * @param {{ db: any, fakes?: ReturnType<typeof createFakes>, extraModules?: any[] }} options
 */
export const boot = async ({ db, fakes = createFakes(), extraModules = [] }) => {
	const config = await testConfig();
	const { logger, entries } = createTestLogger();
	const clock = createClock();
	const portal = createPortal({
		config,
		db,
		modules: [configModule, ...fakes.modules, ...extraModules],
		logger,
		now: clock.now,
	});
	await portal.ensureIndexes();
	/** @type {import('../../../src/modules/config/service.js').ConfigService} */
	const service = /** @type {any} */ (portal.modules.service('config'));
	let seq = 0;
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ cookie?: string, body?: unknown, headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { cookie, body, headers = {} } = {}) => {
		seq += 1;
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(cookie ? { cookie } : {}),
					...(method === 'GET' ? {} : SAME_ORIGIN),
					...(method === 'POST' ? { 'idempotency-key': `k-${seq}` } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null };
	};
	/** @param {import('../../../src/infra/auth.js').SessionInput} input */
	const login = async (input) => {
		const { token } = await portal.shared.sessions.create(input);
		return `${portal.shared.cookies.name(input.kind)}=${token}`;
	};
	return { portal, service, call, login, clock, entries, fakes, db };
};
