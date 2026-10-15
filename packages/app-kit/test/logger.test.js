import { describe, expect, it } from 'vitest';
import { configFromEnv, createLogger, createProduct, defineRoute } from '../src/index.js';
import { noopLogger, redact } from '../src/logger.js';
import { createMemoryStore } from '../src/testing.js';
import { BASE, manifest, setup } from './helpers.js';

/** A logger writing JSON lines into an array, and the lines parsed. */
const capture = () => {
	/** @type {string[]} */
	const lines = [];
	const logger = createLogger({ write: (line) => lines.push(line), now: () => 0 });
	return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) };
};

describe('redaction', () => {
	it('redacts members whose names look like credentials, in any spelling', () => {
		const out = redact({
			uri: 'mongodb://u:p@h',
			mongodbUri: 'x',
			nested: { apiKey: 'k', 'x-api-key': 'k', ok: 1 },
			list: [{ token: 't' }, { refresh_token: 't' }, { accessToken: 't' }],
			clientSecret: 's',
			CONNECT_SECRET: 's',
			password_hash: 'h',
			passphrase: 'p',
			privateKey: 'k',
			privateJwk: { kty: 'EC' },
			d: 'jwk member',
			signingKey: 'k',
			credentials: { user: 'u' },
			connectionString: 'c',
			cookie: 'c',
			Authorization: 'Bearer x',
			kek: 'k',
			pepper: 'p',
			sealed: 'v1.x',
			accessKeyId: 'AKIA',
			secretAccessKey: 's',
			descriptor: { kind: 'aws' },
			error: Object.assign(new Error('m'), { code: 'c' }),
			at: new Date(0),
		});
		expect(out).toEqual({
			uri: '[redacted]',
			mongodbUri: '[redacted]',
			nested: { apiKey: '[redacted]', 'x-api-key': '[redacted]', ok: 1 },
			list: [{ token: '[redacted]' }, { refresh_token: '[redacted]' }, { accessToken: '[redacted]' }],
			clientSecret: '[redacted]',
			CONNECT_SECRET: '[redacted]',
			password_hash: '[redacted]',
			passphrase: '[redacted]',
			privateKey: '[redacted]',
			privateJwk: '[redacted]',
			d: '[redacted]',
			signingKey: '[redacted]',
			credentials: '[redacted]',
			connectionString: '[redacted]',
			cookie: '[redacted]',
			Authorization: '[redacted]',
			kek: '[redacted]',
			pepper: '[redacted]',
			sealed: '[redacted]',
			accessKeyId: '[redacted]',
			secretAccessKey: '[redacted]',
			descriptor: '[redacted]',
			error: { name: 'Error', message: 'm', code: 'c' },
			at: '1970-01-01T00:00:00.000Z',
		});
	});

	it('redacts signed tokens and the user part of addresses inside any text, error messages too', () => {
		const jws = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
		expect(redact({ value: jws, note: `ticket ${jws} refused` })).toEqual({
			value: '[redacted]',
			note: 'ticket [redacted] refused',
		});
		expect(redact({ target: 'mongodb+srv://user:hunter2@cluster.example.net/db?retryWrites=true' })).toEqual({
			target: 'mongodb+srv://[redacted]@cluster.example.net/db?retryWrites=true',
		});
		const error = new Error('could not reach mongodb://user:hunter2@db.example.net:27017 and https://a:b@x.example');
		expect(redact({ error })).toEqual({
			error: {
				name: 'Error',
				message: 'could not reach mongodb://[redacted]@db.example.net:27017 and https://[redacted]@x.example',
			},
		});
		expect(redact({ list: ['plain', 'https://shop.example.com/a@b'] })).toEqual({
			list: ['plain', 'https://shop.example.com/a@b'],
		});
	});

	it('stops at a depth', () => {
		/** @type {any} */
		let deep = {};
		const root = deep;
		for (let i = 0; i < 12; i += 1) deep = deep.next = {};
		expect(JSON.stringify(redact(root))).toContain('[depth]');
	});
});

describe('createLogger', () => {
	it('writes JSON lines above the level', () => {
		/** @type {string[]} */
		const lines = [];
		const logger = createLogger({ level: 'info', write: (line) => lines.push(line), now: () => 0, fields: { app: 'x' } });
		logger.debug('hidden');
		logger.info('shown', { secret: 's' });
		logger.child({ requestId: 'r' }).error('child');
		logger.warn('warned');
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ level: 'info', time: '1970-01-01T00:00:00.000Z', msg: 'shown', app: 'x', secret: '[redacted]' },
			{ level: 'error', time: '1970-01-01T00:00:00.000Z', msg: 'child', app: 'x', requestId: 'r' },
			{ level: 'warn', time: '1970-01-01T00:00:00.000Z', msg: 'warned', app: 'x' },
		]);
		createLogger({ level: 'nope', write: (line) => lines.push(line) }).info('x');
		expect(lines).toHaveLength(4);
		for (const level of /** @type {const} */ (['debug', 'info', 'warn', 'error'])) noopLogger[level]('x');
		expect(noopLogger.child({})).toBe(noopLogger);
		createLogger({ level: 'silent' }).error('never written');
	});

	it('writes to standard output by default', () => {
		/** @type {string[]} */
		const written = [];
		const original = process.stdout.write;
		process.stdout.write = /** @type {any} */ ((/** @type {string} */ chunk) => written.push(chunk));
		try {
			createLogger({ now: () => 0 }).warn('to stdout', { token: 't' });
		} finally {
			process.stdout.write = original;
		}
		expect(written).toEqual([
			`${JSON.stringify({ level: 'warn', time: '1970-01-01T00:00:00.000Z', msg: 'to stdout', token: '[redacted]' })}\n`,
		]);
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
