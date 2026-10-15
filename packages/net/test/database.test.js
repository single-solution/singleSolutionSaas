import { describe, expect, it, vi } from 'vitest';
import { DATABASE_DEADLINES, connectBeforeUse, databaseClientOptions, isDatabaseUnavailable } from '../src/index.js';

describe('databaseClientOptions', () => {
	it('is a small pool with the deadlines, and the app name when given', () => {
		expect(databaseClientOptions()).toEqual({ maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000, ...DATABASE_DEADLINES });
		expect(databaseClientOptions({ maxPoolSize: 2, appName: 'ss-portal' })).toEqual({
			maxPoolSize: 2,
			minPoolSize: 0,
			maxIdleTimeMS: 60_000,
			serverSelectionTimeoutMS: 5_000,
			connectTimeoutMS: 5_000,
			waitQueueTimeoutMS: 10_000,
			socketTimeoutMS: 10_000,
			appName: 'ss-portal',
		});
		expect(databaseClientOptions()).not.toBe(databaseClientOptions());
	});
});

describe('isDatabaseUnavailable', () => {
	it('knows driver network errors, deadlines, failed lookups and maxTimeMS', () => {
		for (const name of ['MongoServerSelectionError', 'MongoNetworkTimeoutError', 'MongoTopologyClosedError'])
			expect(isDatabaseUnavailable(Object.assign(new Error('x'), { name }))).toBe(true);
		expect(isDatabaseUnavailable({ code: 50 })).toBe(true);
		expect(isDatabaseUnavailable({ code: 'EAI_AGAIN' })).toBe(true);
		expect(isDatabaseUnavailable({ code: 'ENOTFOUND' })).toBe(true);
	});

	it('is false for every other error and for what is not an object', () => {
		for (const error of [
			new Error('x'),
			{ code: 11000 },
			{ name: 'MongoServerError' },
			null,
			undefined,
			'MongoNetworkError',
			50,
		])
			expect(isDatabaseUnavailable(error)).toBe(false);
	});
});

describe('connectBeforeUse', () => {
	it('connects once, shares one attempt and forgets a failed one', async () => {
		const connect = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'MongoServerSelectionError' }))
			.mockResolvedValue({});
		const ready = connectBeforeUse({ connect });
		await expect(ready()).rejects.toThrow('down');
		await Promise.all([ready(), ready()]);
		await ready();
		expect(connect).toHaveBeenCalledTimes(2);
	});
});
