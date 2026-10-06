/**
 * `ss certify` against this product: the product runs as a plain node:http server (serve.js → app-kit
 * `createRequestHandler`), the certification suite runs its own Portal emulator on the pinned Portal URL, and the
 * client database is the test run's MongoMemoryReplSet. Every check must pass (CERTIFIABLE).
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noopLogger } from '@ss/app-kit';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createDatabaseResolver, formatReport, runCertification, validateProject } from '@ss/cli';
import { startServer } from '../serve.js';
import { ROOT } from './harness.js';

const TOKEN = 'rt_loyalty_certify_0123456789abcdef';

/** @returns {Promise<number>} */
const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
			server.close(() => resolve(port));
		});
	});

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {string} */
let portalUrl;
const database = createDatabaseResolver({ uri: process.env.TEST_MONGODB_URI ?? null });

beforeAll(async () => {
	portalUrl = `http://127.0.0.1:${await freePort()}`;
	const { privateJwk } = await generateSigningKey({ kid: 'loyalty-certify-1' });
	server = await startServer({
		port: 0,
		root: ROOT,
		env: {
			PORTAL_URL: portalUrl,
			SIGNING_KEY: `${privateJwk.kid}:${privateJwk.d}`,
			REGISTRATION_TOKEN_HASH: hashRegistrationToken(TOKEN),
			LOG_LEVEL: 'error',
		},
		overrides: { logger: noopLogger },
	});
}, 60_000);

afterAll(async () => {
	await server?.close();
	await database.stop();
});

describe('ss certify', () => {
	it('ss app validate passes without errors or warnings', async () => {
		const report = await validateProject(ROOT);
		expect(report.problems).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('passes every certification check (100 %)', async () => {
		const report = await runCertification({ dir: ROOT, url: server.url, portalUrl, token: TOKEN, database });
		const table = formatReport(report);
		expect(
			report.checks.filter((check) => check.status !== 'pass'),
			table,
		).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.summary.passed).toBe(report.checks.length);
		expect(report.summary.passed).toBeGreaterThanOrEqual(47);
		expect(table).toContain('CERTIFIABLE (Listed)');
	}, 180_000);
});
