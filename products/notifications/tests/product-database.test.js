/**
 * Notifications opens its product database itself (it owns the store): the client has the kit's pool and deadlines
 * (K-16), so a database that cannot be reached answers 503 `database_unavailable` within the deadline, never 500 or a
 * request that waits for the driver's 30 s.
 */
import { PRODUCT_DATABASE_OPTIONS } from '@ss/app-kit';
import { afterAll, expect, it, vi } from 'vitest';
import { createProductInstance } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';

/** Clients the product opened, with the options it gave them. */
const opened = vi.hoisted(
	() => /** @type {Array<{ uri: string, options: unknown, client: { close: () => Promise<void> } }>} */ ([]),
);

vi.mock('mongodb', async (importOriginal) => {
	const real = /** @type {typeof import('mongodb')} */ (await importOriginal());
	/**
	 * The real client; only the wait for a server is cut to 0.2 s, so the test does not wait the 5 s deadline.
	 * @param {string} uri
	 * @param {import('mongodb').MongoClientOptions} options
	 */
	function MongoClient(uri, options) {
		const client = new real.MongoClient(uri, { ...options, serverSelectionTimeoutMS: 200 });
		opened.push({ uri, options, client });
		return client;
	}
	return { ...real, MongoClient };
});

afterAll(async () => {
	await Promise.all(opened.map(({ client }) => client.close()));
});

it('opens its product database with the kit’s pool and deadlines and answers 503 while it cannot be reached (K-16)', async () => {
	const product = createProductInstance({
		config: {
			mongodbUri: 'mongodb://127.0.0.1:1/notifications',
			connectSecret: 'connect-secret-0123456789-abcdefghij',
			encryptionKey: 'encryption-key-0123456789-abcdefghij',
		},
		nodeEnv: 'test',
	});
	expect(opened.map(({ uri, options }) => [uri, options])).toEqual([
		['mongodb://127.0.0.1:1/notifications', PRODUCT_DATABASE_OPTIONS],
	]);
	const handler = product.handler(createRoutes(product));
	const response = await handler(
		new Request('https://notifications.example.dev/v1/features', { headers: { authorization: 'Bearer ss_test' } }),
	);
	expect([response.status, response.headers.get('retry-after')]).toEqual([503, '5']);
	expect((await response.json()).type).toMatch(/\/database_unavailable$/);
});
