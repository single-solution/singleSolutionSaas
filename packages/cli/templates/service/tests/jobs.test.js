import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { cronAuthorized } from '../jobs/daily.js';
import { PURGE_INTERVAL_MS, jobRoutes, wireJobs } from '../jobs/index.js';
import { createMemoryCollection } from './memory-collection.js';

/** @param {string | null} authorization */
const request = (authorization) => ({ headers: new Headers(authorization ? { authorization } : {}) });

describe('jobs', () => {
	it('the daily cron route needs the secret and sends the heartbeat', async () => {
		let beats = 0;
		const route = /** @type {any} */ (
			jobRoutes(
				{
					heartbeat: async () => {
						beats += 1;
					},
				},
				{ cronSecret: 's'.repeat(32) },
			)[0]
		);
		assert.equal(route.path, '/cron/daily');
		const denied = /** @type {any} */ (await route.handler(/** @type {any} */ (request('Bearer nope'))));
		assert.equal(denied.code, 'unauthorized');
		const done = /** @type {any} */ (await route.handler(/** @type {any} */ (request(`Bearer ${'s'.repeat(32)}`))));
		assert.deepEqual(done.body, { heartbeat: true });
		assert.equal(beats, 1);
		const failing = /** @type {any} */ (
			jobRoutes({ heartbeat: async () => Promise.reject(new Error('down')) }, { cronSecret: 'x' })[0]
		);
		assert.deepEqual(/** @type {any} */ (await failing.handler(/** @type {any} */ (request('Bearer x')))).body, {
			heartbeat: false,
		});
		assert.equal(cronAuthorized(null, 'x'), false);
		assert.equal(cronAuthorized('Bearer x', null), false);
		assert.equal(jobRoutes({ heartbeat: async () => {} }).length, 1);
	});

	it('registers an hourly per-website purge that runs after requests', async () => {
		const collection = createMemoryCollection();
		/** @type {any[]} */
		const registered = [];
		const product = {
			background: { every: (/** @type {any[]} */ ...args) => registered.push(args) },
			data: {
				forWebsite: async () => ({ ensureIndexes: async () => ({ created: 0 }), collection: () => collection }),
			},
		};
		assert.equal(wireJobs(product), product);
		const [name, interval, run, options] = registered[0];
		assert.equal(name, 'purge');
		assert.equal(interval, PURGE_INTERVAL_MS);
		assert.deepEqual(options, { per: 'website' });
		await collection.insertOne({ websiteId: 'web_1', id: 'n1', text: 'old', deletedAt: '2000-01-01T00:00:00.000Z' });
		assert.equal(await run({ websiteId: 'web_1', deadline: Date.now() + 1000 }), 1);
	});
});
