/**
 * End to end with the real kit: `ss app init` a service product, wire `@ss/*` to the installed packages (no install),
 * start it as a plain node:http server through the template's `serve.js` (app-kit `createRequestHandler`), then run
 * `ss certify` against it with the emulator and a real MongoMemoryServer client database. Every check must pass
 * (the `--minimal` project skips only what it has nothing to exercise: POST replay, pagination, consumed events).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatReport, runCertification } from '../src/certify/index.js';
import { createDatabaseResolver } from '../src/emulator/mongo.js';
import { initApp } from '../src/init.js';
import { freePort, removeDir, tempDir } from './helpers/util.js';

const require = createRequire(import.meta.url);
/**
 * Folder of an `@ss/*` package as this package resolves it (its own dev dependencies: the workspace in the monorepo,
 * the registry once split).
 * @param {string} name
 */
const packageDir = (name) => path.dirname(require.resolve(`@ss/${name}/package.json`));

/** @type {string} */
let root;
const database = createDatabaseResolver();
const SECRET = 'product-e2e-connect-secret-0123456789abcdef';

/**
 * Generate a service product, link `@ss/*` to the workspace and serve it with its own `serve.js`.
 * @param {string} slug
 * @param {{ minimal?: boolean }} [options]
 */
const serveGenerated = async (slug, { minimal = false } = {}) => {
	const dir = path.join(root, slug);
	await initApp({ dir, kind: 'service', slug, name: slug, minimal });
	await mkdir(path.join(dir, 'node_modules', '@ss'), { recursive: true });
	for (const name of ['app-kit', 'contracts', 'protocol', 'entitlements', 'rules']) {
		await symlink(packageDir(name), path.join(dir, 'node_modules', '@ss', name), 'dir');
	}
	const portalUrl = `http://127.0.0.1:${await freePort()}`;
	const { startServer } = await import(pathToFileURL(path.join(dir, 'serve.js')).href);
	/** @type {{ url: string, product: any, close: () => Promise<void> }} */
	const server = await startServer({
		port: 0,
		root: dir,
		env: {
			LOG_LEVEL: 'error',
			CONNECT_SECRET: SECRET,
		},
		overrides: {
			logger: (await import(pathToFileURL(path.join(dir, 'node_modules/@ss/app-kit/src/index.js')).href)).noopLogger,
		},
	});
	return { dir, server, portalUrl };
};

/** @type {Awaited<ReturnType<typeof serveGenerated>>[]} */
const running = [];

beforeAll(async () => {
	root = await tempDir('ss-product-e2e-');
}, 60_000);

afterAll(async () => {
	for (const { server } of running) await server.close();
	await database.stop();
	await removeDir(root);
});

describe('ss certify against a generated app-kit product', () => {
	it('passes every certification check', async () => {
		const generated = await serveGenerated('notes-e2e');
		running.push(generated);
		const report = await runCertification({
			dir: generated.dir,
			url: generated.server.url,
			portalUrl: generated.portalUrl,
			database,
			secret: SECRET,
		});
		const table = formatReport(report);
		expect(
			report.checks.filter((check) => check.status !== 'pass'),
			table,
		).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.summary.passed).toBeGreaterThanOrEqual(46);
		expect(table).toContain('CERTIFIABLE (Listed)');
	}, 120_000);

	it('certifies a --minimal product (placeholder element; no POST, pagination or consumed events to exercise)', async () => {
		const generated = await serveGenerated('bare-e2e', { minimal: true });
		running.push(generated);
		const report = await runCertification({
			dir: generated.dir,
			url: generated.server.url,
			portalUrl: generated.portalUrl,
			database,
			secret: SECRET,
		});
		const table = formatReport(report);
		expect(
			report.checks.filter((check) => check.status === 'fail'),
			table,
		).toEqual([]);
		expect(report.checks.find((check) => check.id === 'certify.target')?.detail).toBe('/v1/status of status (x-ss-certify)');
		expect(
			report.checks
				.filter((check) => check.status === 'skip')
				.map((check) => check.id)
				.sort(),
		).toEqual(['events', 'idempotency.replay', 'pagination.cursor']);
		expect(table).toContain('CERTIFIABLE (Listed)');
	}, 120_000);
});
