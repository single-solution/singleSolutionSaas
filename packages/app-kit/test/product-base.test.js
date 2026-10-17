import { describe, expect, it } from 'vitest';
import { KIT_IMPORT_ROUTES, KIT_ROUTES } from '../src/api.js';
import { createImports } from '../src/imports.js';
import { checkUrl, isSafeMongoUri } from '@ss/net';
import { activityFilter, createProductBase, verifyIdentityToken } from '../src/index.js';
import { createKitRoutes } from '../src/kit-routes.js';
import { createServerApi } from '../src/server-api.js';
import { createTestLogger, manifest } from './helpers.js';

describe('the start-up pieces a product shares with the kit', () => {
	it('opens MongoDB on a healthy configuration, else memory with a warning', () => {
		const mongo = createProductBase({
			config: /** @type {any} */ ({ mongodbUri: 'mongodb://127.0.0.1:1/product' }),
		});
		expect(typeof (/** @type {any} */ (mongo.store).ensureIndexes)).toBe('function');
		const { logger, entries } = createTestLogger();
		const broken = createProductBase({
			config: /** @type {any} */ ({ mongodbUri: 'mongodb://127.0.0.1:1/product' }),
			problems: ['ENCRYPTION_KEY is missing'],
			logger,
		});
		expect(/** @type {any} */ (broken.store).ensureIndexes).toBeUndefined();
		expect(entries).toEqual([{ level: 'warn', msg: 'using the in-memory store: development only' }]);
		expect(/** @type {any} */ (createProductBase({}).store).ensureIndexes).toBeUndefined();
		const store = mongo.store;
		expect(createProductBase({ store, logger }).store).toBe(store);
		expect(entries).toHaveLength(1);
	});

	it('builds the outbound policy (no allowed hosts in production) and send', async () => {
		const outbound = { allowHosts: ['localhost'] };
		expect([...createProductBase({ outbound, nodeEnv: 'test' }).policy.allowHosts]).toEqual(['localhost']);
		expect([...createProductBase({ outbound, nodeEnv: 'production' }).policy.allowHosts]).toEqual([]);
		const outboundSend = async () => /** @type {any} */ ({ ok: true });
		expect(createProductBase({ outboundSend }).send).toBe(outboundSend);
		// safeFetch on the policy: a private address is refused before any request
		await expect(createProductBase({ nodeEnv: 'production' }).send('http://127.0.0.1/x')).rejects.toMatchObject({
			code: 'ssrf_blocked',
		});
	});

	it('under next dev reaches this machine (the other products, a local MongoDB); production still refuses', () => {
		const development = createProductBase({ nodeEnv: 'development' }).policy;
		expect([...development.allowHosts]).toEqual(['localhost', '127.0.0.1', '::1']);
		expect(isSafeMongoUri('mongodb://127.0.0.1:27999/shop_1?replicaSet=testset', development)).toMatchObject({ ok: true });
		expect(checkUrl('http://localhost:3002/v1/send', development)).toMatchObject({ ok: true });
		const production = createProductBase({ nodeEnv: 'production', outbound: { allowHosts: ['127.0.0.1'] } }).policy;
		expect(isSafeMongoUri('mongodb://127.0.0.1:27999/shop_1?replicaSet=testset', production)).toMatchObject({
			ok: false,
		});
		expect(checkUrl('http://localhost:3002/v1/send', production)).toMatchObject({ ok: false });
	});
});

describe('the kit routes as openapi.json documents them', () => {
	it('carry the auth the kit serves them with, and every documented kit route is listed', () => {
		const kit = /** @type {any} */ ({ manifest: manifest(), store: {}, now: Date.now });
		const served = [...createKitRoutes(kit, {}), ...createServerApi(kit, {})];
		for (const route of KIT_ROUTES) {
			const found = served.find((each) => each.method === route.method && each.path === route.path);
			expect(found?.auth).toBe(route.auth);
			// who may call it: the OpenAPI document says what the route says (staff with a permission, or the token alone)
			if (route.auth === 'server') {
				expect([route.path, route.access]).toEqual([route.path, found?.runtime === true ? 'runtime' : 'staff']);
				expect([route.path, route.permission]).toEqual([route.path, found?.permission]);
			}
		}
		const documented = served.filter((route) => ['browser', 'server', 'ticket'].includes(route.auth));
		expect(documented.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
			KIT_ROUTES.map((route) => `${route.method} ${route.path}`).sort(),
		);
		const imports = createImports({
			options: { collections: {} },
			now: Date.now,
			record: async () => {},
			business: async () => /** @type {any} */ ({}),
		}).routes;
		expect(
			imports.map((route) => ({
				method: route.method,
				path: route.path,
				auth: route.auth,
				feature: route.feature,
				access: route.runtime === true ? 'runtime' : 'staff',
			})),
		).toEqual(KIT_IMPORT_ROUTES);
	});
});

describe('exports products share', () => {
	it('activityFilter: the filter of an activity list without the website', () => {
		expect(activityFilter({ actor: 'usr_1', action: 'a.b,c.d', q: ' x ' }, 'UTC')).toMatchObject({
			ok: true,
			filter: { 'actor.id': 'usr_1', action: { $in: ['a.b', 'c.d'] } },
		});
		expect(activityFilter({}, 'UTC')).toEqual({ ok: true, filter: {} });
		expect(activityFilter({ from: 'soon' }, 'UTC')).toMatchObject({ ok: false, field: 'from' });
	});

	it('verifyIdentityToken: a sign-in token checked offline', () => {
		expect(verifyIdentityToken('a.b', { issuer: 'https://accounts.example', jwks: [], audience: 'web_1' })).toEqual({
			ok: false,
			code: 'malformed',
		});
	});
});
