import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { cronAuthorized } from '../jobs/daily.js';
import { jobRoutes, wireJobs } from '../jobs/index.js';

/** @param {string} authorization */
const request = (authorization) => /** @type {any} */ ({ headers: new Headers({ authorization }) });

describe('jobs', () => {
	it('the daily cron route needs the secret and sends the heartbeat', async () => {
		const product = { heartbeat: async () => {} };
		assert.equal(wireJobs(product), product);
		const route = /** @type {any} */ (jobRoutes(product, { cronSecret: 'secret' })[0]);
		assert.equal(/** @type {any} */ (await route.handler(request('Bearer wrong'))).code, 'unauthorized');
		assert.deepEqual(/** @type {any} */ (await route.handler(request('Bearer secret'))).body, { heartbeat: true });
		const failing = /** @type {any} */ (
			jobRoutes({ heartbeat: async () => Promise.reject(new Error('down')) }, { cronSecret: 'secret' })[0]
		);
		assert.deepEqual(/** @type {any} */ (await failing.handler(request('Bearer secret'))).body, { heartbeat: false });
		assert.equal(cronAuthorized(null, 'x'), false);
		assert.equal(jobRoutes(product).length, 1);
	});
});
