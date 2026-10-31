import * as net from '@ss/net';
import { describe, expect, it } from 'vitest';
import { configFromEnv, createLogger, createProduct, defineRoute } from '../src/index.js';
import { noopLogger, redact } from '@ss/net';
import { createMemoryStore } from '../src/testing.js';
import { BASE, manifest, setup } from './helpers.js';

/** A logger writing JSON lines into an array, and the lines parsed. */
const capture = () => {
	/** @type {string[]} */
	const lines = [];
	const logger = createLogger({ write: (line) => lines.push(line), now: () => 0 });
	return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) };
};

describe('the kit logger', () => {
	it('is the one logger of @ss/net', () => {
		expect(createLogger).toBe(net.createLogger);
		expect(noopLogger).toBe(net.noopLogger);
		expect(redact).toBe(net.redact);
	});
});

describe('a product logs what goes wrong', () => {
	it('a route that fails answers 500 and is logged with its route and request id, secrets redacted', async () => {
		const { logger, records } = capture();
		const fail = defineRoute({
			method: 'GET',
			path: '/v1/fail',
			auth: 'none',
			handler: () => {
				throw new Error('lost mongodb+srv://user:hunter2@cluster.example.net');
			},
		});
		const { call } = await setup({ logger, routes: [fail] });
		const response = await call('GET', '/v1/fail');
		expect(response.status).toBe(500);
		const failed = records().find((record) => record.msg === 'route handler failed');
		expect(failed).toEqual({
			level: 'error',
			time: '1970-01-01T00:00:00.000Z',
			msg: 'route handler failed',
			requestId: response.headers.get('x-request-id'),
			route: 'GET /v1/fail',
			error: { name: 'Error', message: 'lost mongodb+srv://[redacted]@cluster.example.net' },
		});
		expect(records()).toContainEqual(
			expect.objectContaining({ level: 'info', msg: 'request', method: 'GET', path: '/v1/fail', status: 500 }),
		);
		expect(JSON.stringify(records())).not.toContain('hunter2');
	});

	it('a misconfigured product logs the problems once, never the values, and answers 503', async () => {
		const { logger, records } = capture();
		const env = {
			MONGODB_URI: 'postgres://user:hunter2@db',
			CONNECT_SECRET: 'short-secret',
			ENCRYPTION_KEY: 'enc-key-too-short',
		};
		const { config, problems } = configFromEnv(env);
		const product = createProduct({ manifest: manifest(), config, problems, logger, store: createMemoryStore() });
		const misconfigured = records().filter((record) => record.msg === 'product is misconfigured: every route answers 503');
		expect(misconfigured).toEqual([
			{
				level: 'error',
				time: '1970-01-01T00:00:00.000Z',
				msg: 'product is misconfigured: every route answers 503',
				problems: [
					'MONGODB_URI is missing or is not a MongoDB connection string.',
					'CONNECT_SECRET is missing or shorter than 32 characters.',
					'ENCRYPTION_KEY is missing or shorter than 32 characters.',
				],
			},
		]);
		const response = await product.handler([])(new Request(`${BASE}/docs`));
		expect(response.status).toBe(503);
		expect(records()).toContainEqual(expect.objectContaining({ msg: 'request', path: '/docs', status: 503 }));
		const written = JSON.stringify(records());
		for (const value of Object.values(env)) expect(written).not.toContain(value);
	});
});
