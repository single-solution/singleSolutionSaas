/**
 * End to end with the real kit: `ss app init` a service product, wire `@ss/*` to the workspace packages (no install),
 * start it as a plain node:http server through the template's `serve.js` (app-kit `createRequestHandler`), then run
 * `ss certify` against it with the emulator and a real MongoMemoryServer client database. Every check must pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { formatReport, runCertification } from '../src/certify/index.js';
import { createDatabaseResolver } from '../src/emulator/mongo.js';
import { initApp } from '../src/init.js';
import { freePort, removeDir, tempDir } from './helpers/util.js';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'rt_product_e2e_token_0123456789abcdef';

/** @type {string} */
let root;
/** @type {string} */
let dir;
/** @type {{ url: string, product: any, close: () => Promise<void> }} */
let server;
/** @type {string} */
let portalUrl;
const database = createDatabaseResolver();

beforeAll(async () => {
	root = await tempDir('ss-product-e2e-');
	dir = path.join(root, 'notes-e2e');
	await initApp({ dir, kind: 'service', slug: 'notes-e2e', name: 'Notes E2E' });
	await mkdir(path.join(dir, 'node_modules', '@ss'), { recursive: true });
	for (const name of ['app-kit', 'contracts', 'protocol', 'entitlements', 'rules']) {
		await symlink(path.join(PACKAGES, name), path.join(dir, 'node_modules', '@ss', name), 'dir');
	}
	portalUrl = `http://127.0.0.1:${await freePort()}`;
	const { privateJwk } = await generateSigningKey({ kid: 'notes-e2e-1' });
	const { startServer } = await import(pathToFileURL(path.join(dir, 'serve.js')).href);
	server = await startServer({
		port: 0,
		root: dir,
		env: {
			SS_PORTAL_URL: portalUrl,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken(TOKEN),
			SS_LOG_LEVEL: 'error',
		},
		overrides: {
			logger: (await import(pathToFileURL(path.join(dir, 'node_modules/@ss/app-kit/src/index.js')).href)).noopLogger,
		},
	});
}, 60_000);

afterAll(async () => {
	await server?.close();
	await database.stop();
	await removeDir(root);
});

describe('ss certify against a generated app-kit product', () => {
	it('passes every certification check', async () => {
		const report = await runCertification({ dir, url: server.url, portalUrl, token: TOKEN, database });
		const table = formatReport(report);
		expect(
			report.checks.filter((check) => check.status !== 'pass'),
			table,
		).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.summary.passed).toBeGreaterThanOrEqual(47);
		expect(table).toContain('CERTIFIABLE (Listed)');
	}, 120_000);
});
