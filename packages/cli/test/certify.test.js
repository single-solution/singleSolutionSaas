import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { generateSigningKey } from '@ss/protocol';
import { certificationTarget, formatReport, nextCursorOf, problemShapeError, runCertification } from '../src/certify/index.js';
import { initApp } from '../src/init.js';
import { loadManifest } from '../src/manifest.js';
import { FAKE_SECRET, createFakeProduct } from './helpers/fake-product.js';
import { freePort, removeDir, tempDir } from './helpers/util.js';

const database = {
	resolve: async (/** @type {{ merchantId: string }} */ { merchantId }) => ({
		uri: `mongodb://127.0.0.1:1/client_${merchantId}`,
		dbName: `client_${merchantId}`,
	}),
};

/** @type {string} */
let root;
/** @type {string} */
let dir;
/** @type {unknown} */
let manifest;

beforeAll(async () => {
	root = await tempDir('ss-certify-');
	dir = path.join(root, 'svc');
	await initApp({ dir, kind: 'service', slug: 'cert-notes', name: 'Cert Notes' });
	manifest = (await loadManifest(dir)).manifest;
});
afterAll(async () => {
	await removeDir(root);
});

/** @param {Record<string, boolean>} [broken] @param {Partial<Parameters<typeof runCertification>[0]>} [options] */
const certify = async (broken = {}, options = {}) => {
	const portalUrl = `http://127.0.0.1:${await freePort()}`;
	const product = createFakeProduct({
		manifest,
		portalUrl,
		signingKey: (await generateSigningKey({ kid: 'cert-app-1' })).privateJwk,
		broken,
	});
	const url = await product.start();
	try {
		return await runCertification({ dir, url, portalUrl, database, secret: FAKE_SECRET, ...options });
	} finally {
		await product.stop();
	}
};

/** @param {import('../src/certify/index.js').CertificationReport} report */
const failed = (report) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id);

describe('ss certify (service)', () => {
	it('certifies a conformant product end to end', async () => {
		/** @type {string[]} */
		const lines = [];
		const report = await certify({}, { log: (line) => lines.push(line) });
		expect(failed(report)).toEqual([]);
		expect(report.ok).toBe(true);
		const ids = report.checks.map((check) => check.id);
		for (const id of [
			'connection.rejects-wrong-secret',
			'connection.connect',
			'connection.reconnect',
			'launch.merchant',
			'launch.demo',
			'launch.admin',
			'launch.impersonate',
			'launch.partner',
			'launch.developer',
			'launch.replay',
			'launch.expired',
			'launch.audience',
			'launch.forged',
			'keys.pk-foreign-origin',
			'gating.element-disabled',
			'idempotency.replay',
			'pagination.cursor',
			'standard.strings',
			'events.idempotent',
			'events.tampered',
			'data.guard',
			'data.export',
			'data.anonymize',
			'entitlement.offline-grace',
		])
			expect(ids).toContain(id);
		expect(report.summary.skipped).toBe(0);
		expect(formatReport(report)).toContain('CERTIFIABLE (Listed)');
		expect(lines.some((line) => line.startsWith('PASS'))).toBe(true);
	}, 60_000);

	it.each([
		[{ originCheck: true }, ['keys.pk-foreign-origin']],
		[{ pkServerError: true }, ['keys.pk-resources']],
		[{ pkFlaky: true }, ['keys.pk-resources']],
		[{ pkRefused: true }, []],
		[
			{ problems: true },
			['keys.missing', 'keys.pk-foreign-origin', 'errors.problem', 'gating.element-disabled', 'idempotency.required'],
		],
		[{ gating: true }, ['gating.element-disabled']],
		[{ idempotency: true }, ['idempotency.replay']],
		[{ pagination: true }, []],
		[{ launchReplay: true }, ['launch.replay']],
		[{ eventDedupe: true }, ['events.idempotent']],
		[{ dataGuard: true }, ['data.guard']],
		[{ offlineGrace: true }, ['entitlement.offline-grace']],
		[{ controlEvents: true }, ['control.key-revoked', 'control.entitlement-changed']],
		[{ siteEvents: true }, ['standard.events']],
		[{ sessionView: true }, []],
	])(
		'detects a broken product %o',
		async (broken, expected) => {
			const report = await certify(broken);
			for (const id of expected) expect(failed(report)).toContain(id);
			if (expected.length > 0) expect(report.ok).toBe(false);
			if (expected.length > 0) expect(formatReport(report)).toContain('NOT CERTIFIABLE');
		},
		60_000,
	);

	it('requires sk_-only resources (x-ss-key-kind: sk) to refuse pk_ keys', async () => {
		const file = path.join(dir, 'openapi.json');
		const original = await readFile(file, 'utf8');
		const spec = JSON.parse(original);
		spec.paths['/v1/notes'].get['x-ss-key-kind'] = 'sk';
		await writeFile(file, JSON.stringify(spec, null, '\t'));
		try {
			expect(failed(await certify())).toContain('keys.pk-resources');
			const refused = await certify({ pkRefused: true });
			expect(refused.checks.find((check) => check.id === 'keys.pk-resources')?.status).toBe('pass');
		} finally {
			await writeFile(file, original);
		}
	}, 120_000);

	it('certifies the resource marked x-ss-certify and fails on a mark outside the Mode C resources', async () => {
		const file = path.join(dir, 'openapi.json');
		const original = await readFile(file, 'utf8');
		const spec = JSON.parse(original);
		try {
			spec.paths['/v1/notes'].post['x-ss-certify'] = true;
			await writeFile(file, JSON.stringify(spec, null, '\t'));
			const marked = await certify();
			expect(failed(marked)).toEqual([]);
			expect(marked.checks.find((check) => check.id === 'certify.target')?.detail).toBe('/v1/notes of notes (x-ss-certify)');
			spec.paths['/v1/strings'] = { ...spec.paths['/v1/strings'], 'x-ss-certify': true };
			await writeFile(file, JSON.stringify(spec, null, '\t'));
			const twice = await certify();
			expect(failed(twice)).toContain('certify.target');
			expect(twice.ok).toBe(false);
		} finally {
			await writeFile(file, original);
		}
	}, 120_000);

	it('skips the live suite without --url', async () => {
		const noUrl = await runCertification({ dir });
		expect(noUrl.checks.map((check) => `${check.id}:${check.status}`)).toEqual(['project.validate:pass', 'service.url:skip']);
	}, 60_000);

	it('fails fast when the Portal port is busy or the project is invalid', async () => {
		const port = await freePort();
		const { createServer } = await import('node:http');
		const blocker = createServer().listen(port, '127.0.0.1');
		await new Promise((resolve) => blocker.once('listening', resolve));
		try {
			const report = await runCertification({
				dir,
				url: 'http://127.0.0.1:1',
				portalUrl: `http://127.0.0.1:${port}`,
				database,
			});
			expect(report.checks.find((check) => check.id === 'emulator.start')).toMatchObject({
				status: 'fail',
				detail: expect.stringMatching(/busy/),
			});
		} finally {
			blocker.close();
		}
		const broken = path.join(root, 'broken');
		await initApp({ dir: broken, kind: 'service', slug: 'broken', name: 'Broken' });
		await writeFile(path.join(broken, 'manifest.json'), '{}');
		const report = await runCertification({ dir: broken, url: 'http://127.0.0.1:1' });
		expect(report).toMatchObject({ ok: false, kind: 'unknown', checks: [{ id: 'project.validate', status: 'fail' }] });
	});
});

describe('ss certify (pack)', () => {
	it('validates and smoke-tests headless core and renderer', async () => {
		const pack = path.join(root, 'pack');
		await initApp({ dir: pack, kind: 'pack', slug: 'cert-pack', name: 'Cert Pack' });
		const report = await runCertification({ dir: pack });
		expect(report.checks.map((check) => `${check.id}:${check.status}`)).toEqual([
			'project.validate:pass',
			'pack.notes.headless:pass',
			'pack.notes.renderer:pass',
		]);
		expect(report.kind).toBe('pack');
	});
});

describe('certify helpers', () => {
	it('chooses the certification resource: x-ss-certify, else the first Mode C resource', () => {
		const element = (/** @type {string} */ key, /** @type {string[]} */ resources, modes = ['C']) => ({
			key,
			name: key,
			modes,
			price: { hourly: 0 },
			api: { resources },
		});
		const manifest = /** @type {any} */ ({
			elements: [
				element('widget', ['widgets'], ['A', 'B']),
				element('alpha', ['alphas', 'alpha-items']),
				element('beta', ['betas']),
			],
		});
		expect(certificationTarget(manifest, {})).toMatchObject({
			ok: true,
			resource: 'alphas',
			source: 'first',
			element: { key: 'alpha' },
		});
		expect(certificationTarget(manifest, { '/v1/betas': { get: { 'x-ss-certify': true } } })).toMatchObject({
			ok: true,
			resource: 'betas',
			source: 'x-ss-certify',
			element: { key: 'beta' },
		});
		expect(certificationTarget(manifest, { '/v1/alpha-items': { 'x-ss-certify': true, get: {} } })).toMatchObject({
			resource: 'alpha-items',
			element: { key: 'alpha' },
		});
		expect(certificationTarget(manifest, { '/v1/betas': { get: { 'x-ss-certify': false } } })).toMatchObject({
			resource: 'alphas',
		});
		expect(certificationTarget(manifest, { '/v1/widgets': { 'x-ss-certify': true } })).toMatchObject({
			ok: false,
			problem: expect.stringMatching(/not \/v1\/<resource>/),
		});
		expect(certificationTarget(manifest, { '/v1/betas/{id}': { get: { 'x-ss-certify': true } } })).toMatchObject({ ok: false });
		expect(
			certificationTarget(manifest, {
				'/v1/betas': { 'x-ss-certify': true },
				'/v1/alphas': { post: { 'x-ss-certify': true } },
			}),
		).toMatchObject({ ok: false, problem: expect.stringMatching(/2 paths/) });
		expect(certificationTarget(/** @type {any} */ ({ elements: [element('ui', [], ['A', 'B'])] }), {})).toMatchObject({
			ok: true,
			resource: undefined,
		});
	});

	/** @param {number} status @param {Record<string, string>} headers @param {unknown} json */
	const result = (status, headers, json) => ({ status, headers: new Headers(headers), text: JSON.stringify(json), json });
	it('recognises RFC 9457 problems', () => {
		expect(
			problemShapeError(result(404, { 'content-type': 'application/problem+json' }, { type: 'x', title: 'y', status: 404 })),
		).toBeNull();
		expect(problemShapeError(result(404, { 'content-type': 'application/json' }, {}))).toMatch(/content-type/);
		expect(problemShapeError(result(404, { 'content-type': 'application/problem+json' }, null))).toMatch(/object/);
		expect(problemShapeError(result(404, { 'content-type': 'application/problem+json' }, { type: 1 }))).toMatch(
			/type and title/,
		);
		expect(
			problemShapeError(result(404, { 'content-type': 'application/problem+json' }, { type: 'x', title: 'y', status: 400 })),
		).toMatch(/≠/);
	});
	it('finds next cursors in Link, X-Next-Cursor or the body', () => {
		expect(nextCursorOf(result(200, { link: '</v1/a?cursor=c1>; rel="next", </v1/a>; rel="first"' }, {}))).toEqual({
			cursor: 'c1',
			source: 'Link',
		});
		expect(nextCursorOf(result(200, { 'x-next-cursor': 'c2' }, {}))).toEqual({ cursor: 'c2', source: 'X-Next-Cursor' });
		expect(nextCursorOf(result(200, {}, { nextCursor: 'c3' }))).toEqual({ cursor: 'c3', source: 'body.nextCursor' });
		expect(nextCursorOf(result(200, { link: '</v1/a>; rel="next"' }, {}))).toBeNull();
	});
});
