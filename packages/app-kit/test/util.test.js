import { describe, expect, it } from 'vitest';
import {
	collectionPrefix,
	createSingleFlight,
	isKitError,
	kitError,
	parseDurationMs,
	readHeader,
	stableJson,
} from '../src/util.js';
import { createLogger, noopLogger, redact } from '../src/logger.js';
import { configFromEnv } from '../src/env.js';

describe('util', () => {
	it('parses ISO-8601 durations', () => {
		expect(parseDurationMs('PT24H', 0)).toBe(86_400_000);
		expect(parseDurationMs('P1DT30M', 0)).toBe(86_400_000 + 1_800_000);
		expect(parseDurationMs('P2W', 0)).toBe(14 * 86_400_000);
		expect(parseDurationMs('PT1.5S', 0)).toBe(1500);
		expect(parseDurationMs('P1Y', 7)).toBe(7);
		expect(parseDurationMs('P', 7)).toBe(7);
		expect(parseDurationMs('PT', 7)).toBe(7);
		expect(parseDurationMs(undefined, 9)).toBe(9);
	});

	it('builds collection prefixes', () => {
		expect(collectionPrefix('coupon-box')).toBe('ss_coupon_box_');
	});

	it('serialises JSON deterministically', () => {
		expect(stableJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
		expect(stableJson(undefined)).toBe('null');
	});

	it('shares in-flight promises', async () => {
		const flight = createSingleFlight();
		let calls = 0;
		const run = async () => {
			calls += 1;
			return calls;
		};
		const [a, b] = await Promise.all([flight('k', run), flight('k', run)]);
		expect([a, b, calls]).toEqual([1, 1, 1]);
		expect(await flight('k', run)).toBe(2);
	});

	it('reads headers from records and Headers', () => {
		expect(readHeader({ 'X-A': '1' }, 'x-a')).toBe('1');
		expect(readHeader({ 'x-a': ['1', '2'] }, 'x-a')).toBeUndefined();
		expect(readHeader({ 'x-a': ['1'] }, 'x-a')).toBe('1');
		expect(readHeader({ 'x-a': '1', 'X-A': '2' }, 'x-a')).toBeUndefined();
		expect(readHeader(new Headers({ 'x-a': '3' }), 'X-A')).toBe('3');
		expect(readHeader(undefined, 'x')).toBeUndefined();
	});

	it('creates typed errors', () => {
		const error = kitError('x', 'boom', { a: 1 });
		expect(isKitError(error)).toBe(true);
		expect(isKitError(error, 'x')).toBe(true);
		expect(isKitError(error, 'y')).toBe(false);
		expect(isKitError(new Error('x'))).toBe(false);
	});
});

describe('logger', () => {
	it('redacts credentials and serialises errors', () => {
		const out = redact({
			uri: 'mongodb://u:p@h',
			nested: { apiKey: 'k', ok: 1 },
			list: [{ token: 't' }],
			error: Object.assign(new Error('m'), { code: 'c' }),
		});
		expect(out).toEqual({
			uri: '[redacted]',
			nested: { apiKey: '[redacted]', ok: 1 },
			list: [{ token: '[redacted]' }],
			error: { name: 'Error', message: 'm', code: 'c' },
		});
		/** @type {any} */
		let deep = {};
		const root = deep;
		for (let i = 0; i < 10; i += 1) deep = deep.next = {};
		expect(JSON.stringify(redact(root))).toContain('[depth]');
		expect(redact(new Error('plain'))).toEqual({ name: 'Error', message: 'plain' });
	});

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
		const unknownLevel = createLogger({ level: 'nope', write: (line) => lines.push(line) });
		unknownLevel.info('x');
		expect(lines).toHaveLength(4);
		noopLogger.info('x');
		noopLogger.debug('x');
		noopLogger.warn('x');
		noopLogger.error('x');
		expect(noopLogger.child({})).toBe(noopLogger);
	});

	it('defaults to stdout without console', () => {
		const logger = createLogger({ level: 'silent' });
		logger.error('never written');
	});
});

describe('configFromEnv', () => {
	it('reads the documented variables', () => {
		expect(
			configFromEnv({
				DATABASE_URI: 'mongodb://x',
				LOG_LEVEL: 'debug',
				OUTBOUND_DEV_ALLOW_HOSTS: ' minio.dev , 127.0.0.1,,',
			}),
		).toEqual({
			productDbUri: 'mongodb://x',
			productDbOptions: { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 5_000 },
			logLevel: 'debug',
			outboundAllowHosts: ['minio.dev', '127.0.0.1'],
		});
		expect(configFromEnv({ NODE_ENV: 'production', DATABASE_URI: 'mongodb://x' })).toMatchObject({
			logLevel: 'info',
			outboundAllowHosts: [],
		});
		expect(configFromEnv({ NODE_ENV: 'development' }).logLevel).toBe('debug');
		expect(configFromEnv()).toHaveProperty('logLevel');
		expect(configFromEnv({ DATABASE_MAX_POOL_SIZE: '2' }).productDbOptions.maxPoolSize).toBe(2);
		expect(configFromEnv({ DATABASE_MAX_POOL_SIZE: 'lots' }).productDbOptions.maxPoolSize).toBe(5);
	});
});
