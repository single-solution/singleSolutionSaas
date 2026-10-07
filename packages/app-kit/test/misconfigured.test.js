import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MONGODB_URI_REQUIRED,
	configFromEnv,
	configProblems,
	createProduct,
	createRequestHandler,
	standardRoutes,
} from '../src/index.js';
import { proxy } from '../src/proxy.js';
import { createTestLogger, manifest } from './helpers.js';

const BASE = 'https://coupons.deploy.test';

/** @param {{ problems?: string[], connectSecret?: string }} [options] */
const productWith = ({ problems, connectSecret } = {}) => {
	const { logger, entries } = createTestLogger();
	const product = createProduct({
		manifest: manifest(),
		logger,
		nodeEnv: 'test',
		...(problems ? { problems } : {}),
		...(connectSecret === undefined ? {} : { connectSecret }),
	});
	return { product, handle: createRequestHandler(product, standardRoutes(product)), logs: entries };
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('configuration problems', () => {
	it('names MONGODB_URI in production (not during the build), never values', () => {
		expect(configProblems({ NODE_ENV: 'production' })).toEqual([MONGODB_URI_REQUIRED]);
		expect(configProblems({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })).toEqual([]);
		expect(configProblems({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://db/x' })).toEqual([]);
		expect(configProblems({ NODE_ENV: 'development' })).toEqual([]);
		expect(configFromEnv({ NODE_ENV: 'production' })).toMatchObject({
			productDbUri: undefined,
			problems: [MONGODB_URI_REQUIRED],
		});
	});

	it('a misconfigured product starts and answers every route 503 with the problems', async () => {
		const { product, handle, logs } = productWith({ problems: [MONGODB_URI_REQUIRED, MONGODB_URI_REQUIRED, ''] });
		expect(product.problems).toEqual([MONGODB_URI_REQUIRED]);
		expect(logs.some((entry) => entry.level === 'error')).toBe(true);
		for (const path of ['/.well-known/ss-app.json', '/v1/strings', '/v1/entitlement', '/nope']) {
			const res = await handle(new Request(`${BASE}${path}`));
			expect(res.status).toBe(503);
			expect(res.headers.get('content-type')).toBe('application/json');
			expect(res.headers.get('cache-control')).toBe('no-store');
			expect(await res.json()).toEqual({ status: 'misconfigured', problems: [MONGODB_URI_REQUIRED] });
		}
		const connect = await handle(new Request(`${BASE}/.well-known/ss-connect`, { method: 'POST', body: '{}' }));
		expect(connect.status).toBe(503);
	});

	it('a product without problems serves as before', async () => {
		const { product, handle } = productWith();
		expect(product.problems).toEqual([]);
		expect((await handle(new Request(`${BASE}/.well-known/ss-app.json`))).status).toBe(200);
	});

	it('a missing or too-short CONNECT_SECRET keeps the product running; connect names the problem', async () => {
		for (const [secret, pattern] of /** @type {const} */ ([
			[undefined, /CONNECT_SECRET is not set/],
			['short', /CONNECT_SECRET is shorter than 32 characters/],
		])) {
			const { handle } = productWith(secret === undefined ? {} : { connectSecret: secret });
			expect((await handle(new Request(`${BASE}/.well-known/ss-app.json`))).status).toBe(200);
			const res = await handle(new Request(`${BASE}/.well-known/ss-connect`, { method: 'POST', body: '{}' }));
			expect(res.status).toBe(503);
			const body = await res.json();
			expect(body.code).toBe('misconfigured');
			expect(body.detail).toMatch(pattern);
			expect(body.problems).toEqual([body.detail]);
			expect(JSON.stringify(body)).not.toContain('"short"');
		}
	});
});

describe('@ss/app-kit/proxy', () => {
	it('answers 503 with the problems while misconfigured, and lets requests through otherwise', async () => {
		vi.stubEnv('NODE_ENV', 'production');
		vi.stubEnv('MONGODB_URI', '');
		const res = /** @type {Response} */ (proxy());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'misconfigured', problems: [MONGODB_URI_REQUIRED] });
		vi.stubEnv('MONGODB_URI', 'mongodb://db/x');
		expect(proxy()).toBeUndefined();
	});
});

describe('startupFailedResponse', () => {
	it('answers 503 with a scrubbed reason', async () => {
		const { startupFailedResponse } = await import('../src/misconfigured.js');
		const response = startupFailedResponse(
			new Error('connect failed mongodb+srv://user:pa55@cluster.example.net/x token abcdefghijklmnopqrstuvwxyz0123456789ABCD'),
		);
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body.status).toBe('unavailable');
		expect(body.problems[0]).toMatch(/^Start-up failed: connect failed mongodb\+srv:\/\/\[redacted\]@cluster\.example\.net/);
		expect(body.problems[0]).not.toMatch(/pa55|abcdefghijklmnop/);
		expect((await startupFailedResponse('plain').json()).problems[0]).toBe('Start-up failed: plain');
	});
});
