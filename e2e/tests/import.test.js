/**
 * PLAN 0.8.10 Migration: importing with `ss-import` through the real products' import routes (K10, feature `import`)
 * with the Portal-issued server tokens.
 *
 * 1. The importer's small fixture into the test product Notes: `read` (read only) into NDJSON files, a dry run that
 *    writes nothing, the real run with the given ids (re-runnable), `finish`, and `verify` against
 *    `GET /v1/import/status` and the count route (K4).
 * 2. The example shop (`@ss/importer/fixture`: people, catalog, orders, chats and analytics) into Accounts, Ecommerce,
 *    Chat and Growth: a dry run (nothing written; the settings that would change and every refused record listed by
 *    file and line), the real run (settings first, then every collection in order, each product finished after its
 *    last file), `verify` (counts and sums match), the products' own read routes (a product page, an order by number,
 *    a customer's points, a conversation, the analytics report, an imported member signing in with the old password),
 *    a re-run that changes nothing, and a prune after one record is removed from the source.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read, send, verify } from '@ss/importer';
import {
	EXPECTED,
	FIXTURE_MAPPING,
	SHOP_GUEST_COOKIE,
	SHOP_IDS,
	SHOP_MAPPING,
	SHOP_PASSWORDS,
	seed,
	seedShop,
	shopHex,
} from '@ss/importer/fixture';
import * as accounts from '@ss/product-accounts/product';
import * as accountsRoutes from '@ss/product-accounts/routes';
import * as chat from '@ss/product-chat/product';
import * as chatRoutes from '@ss/product-chat/routes';
import * as ecommerce from '@ss/product-ecommerce/product';
import * as ecommerceRoutes from '@ss/product-ecommerce/routes';
import * as growth from '@ss/product-growth/product';
import * as growthRoutes from '@ss/product-growth/routes';
import { PRODUCT_URL, codeOf, startSystem } from './helpers.js';

/**
 * The importer's fetch, routed to the products in process (the same requests a real `ss-import` sends over https).
 * @param {import('./helpers.js').System} system
 * @returns {typeof globalThis.fetch}
 */
const fetchInto = (system) => async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const answer = await system.call(request.method, `${url.pathname}${url.search}`, {
		base: url.origin,
		headers: Object.fromEntries(request.headers.entries()),
		...(request.method === 'GET' ? {} : { body: await request.text() }),
	});
	return new Response(answer.json === null ? null : JSON.stringify(answer.json), { status: answer.status });
};

/** The store's database, a copy read only, and an empty output folder. */
const sourceAndFolder = async () => {
	const client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	const db = client.db(`e2e_store_${randomBytes(4).toString('hex')}`);
	const dir = await mkdtemp(path.join(tmpdir(), 'ss-import-e2e-'));
	return {
		client,
		db,
		dir,
		close: async () => {
			await db.dropDatabase();
			await client.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
};

describe('importing a store into a product (K10, ss-import)', () => {
	/** @type {import('./helpers.js').System} */
	let sys;
	let websiteId = '';
	/** @type {{ browser: string, server: string }} */
	let tokens;
	/** @type {Awaited<ReturnType<typeof sourceAndFolder>>} */
	let source;
	/** @type {import('mongodb').Db} */
	let merchantDb;
	let cookie = '';
	/** @type {typeof globalThis.fetch} */
	let fetch;

	beforeAll(async () => {
		sys = await startSystem();
		fetch = fetchInto(sys);
		await sys.connect();
		const m = await sys.merchant('import@shop.test', ['import.example.com']);
		websiteId = m.websiteIds[0] ?? '';
		await sys.addProduct(m.merchantId, websiteId);
		cookie = await sys.adminSession(await sys.owner(), websiteId);
		merchantDb = await sys.connectDatabase(cookie, websiteId);
		tokens = await sys.tokens(m.merchantId, websiteId);
		source = await sourceAndFolder();
		await seed(source.db);
	});
	afterAll(async () => {
		await source?.close();
		await sys?.stop();
	});

	it('is refused while the import feature is off', async () => {
		await sys.switchFeatures(cookie, websiteId, ['notes']);
		const refused = await sys.call('POST', '/v1/import/notes?dryRun=1', {
			token: tokens.server,
			body: '{}\n',
			headers: { 'content-type': 'application/x-ndjson' },
		});
		expect([refused.status, codeOf(refused)]).toEqual([403, 'feature_off']);
	});

	it('dry-runs the fixture: every record checked, nothing written', async () => {
		await sys.switchFeatures(cookie, websiteId, ['notes', 'import']);
		const { dir } = source;
		const manifest = await read({ mapping: FIXTURE_MAPPING, db: source.db, dir });
		expect(manifest.steps[0]).toMatchObject({ product: 'notes', collection: 'notes', ...EXPECTED });
		const products = { notes: { url: PRODUCT_URL, token: tokens.server } };
		const dry = await send({ dir, products, dryRun: true, fetch });
		expect(dry).toMatchObject({ dryRun: true, ok: true, finished: [] });
		expect(dry.steps[0]).toMatchObject({ inserted: EXPECTED.records, updated: 0, failed: [] });
		expect(await merchantDb.collection('ss_notes_notes').countDocuments({})).toBe(0);
		expect(await merchantDb.collection('ss_notes_activity').countDocuments({})).toBe(0);
		const before = await verify({ dir, products, fetch });
		expect(before).toMatchObject({ ok: false, steps: [{ expected: 3, imported: 0, counted: 0, match: false }] });
	});

	it('imports for real with the given ids, finishes, re-runs safely and verifies', async () => {
		const { dir } = source;
		const products = { notes: { url: PRODUCT_URL, token: tokens.server } };
		const real = await send({ dir, products, fetch });
		expect(real.steps[0]).toMatchObject({ inserted: 3, updated: 0, failed: [] });
		expect(real.finished).toEqual([{ product: 'notes', summary: { finished: true } }]);
		expect((await send({ dir, products, fetch })).steps[0]).toMatchObject({ inserted: 0, updated: 3 });
		const list = await sys.call('GET', '/v1/notes?limit=10', { token: tokens.server });
		expect(list.json.items.map((/** @type {{ id: string }} */ note) => note.id)).toEqual([
			'note_64b0c0ffee00000000000006',
			'note_64b0c0ffee00000000000002',
			'note_64b0c0ffee00000000000001',
		]);
		expect(list.json.items[2]).toMatchObject({ email: 'chloe@example.com', createdAt: '2024-01-05T10:00:00.000Z' });
		expect(await verify({ dir, products, fetch })).toEqual({
			ok: true,
			steps: [{ product: 'notes', collection: 'notes', expected: 3, imported: 3, stored: 3, counted: 3, match: true }],
			totals: [],
		});
		// each call wrote one activity entry, never copied to Accounts; the dry run wrote none
		const activity = await sys.call('GET', '/v1/activity?action=import.notes', { token: tokens.server });
		expect(activity.json.items.map((/** @type {{ detail: string }} */ entry) => entry.detail)).toEqual([
			'0 inserted, 3 updated, 0 failed',
			'3 inserted, 0 updated, 0 failed',
		]);
		expect(await merchantDb.collection('ss_notes_activity').countDocuments({ copy: { $ne: 'none' } })).toBe(0);
	});

	it('reports a record the product refuses, by line', async () => {
		const answer = await sys.call('POST', '/v1/import/notes?dryRun=1', {
			token: tokens.server,
			body: `${JSON.stringify({ id: 'note_64b0c0ffee00000000000007', text: '', createdAt: '2024-01-01T00:00:00Z' })}\n`,
			headers: { 'content-type': 'application/x-ndjson' },
		});
		expect(answer.json).toEqual({
			inserted: 0,
			updated: 0,
			dryRun: true,
			failed: [
				{ line: 1, id: 'note_64b0c0ffee00000000000007', errors: [{ path: '/text', message: 'text is not valid (empty)' }] },
			],
		});
	});
});

// ------------------------------------------------------------------------------------------- the example shop

const BASES = Object.freeze({
	accounts: 'https://accounts-import.test',
	ecommerce: 'https://ecommerce-import.test',
	chat: 'https://chat-import.test',
	growth: 'https://growth-import.test',
});
/** @typedef {keyof typeof BASES} ProductKey */
const DOMAIN = 'shop.example.com';
const ORIGIN = `https://${DOMAIN}`;
/** The merchant's server calls for one shopper (K3). */
const VISITOR = { 'ss-visitor-ip': '198.51.100.20' };

/** The features each product has on for the move (`import` among them). @type {Record<ProductKey, string[]>} */
const FEATURES = {
	accounts: ['email_password', 'phone_password', 'roles', 'import'],
	ecommerce: [
		'catalog',
		'variants',
		'size_charts',
		'checkout',
		'cod',
		'deals',
		'loyalty',
		'reviews',
		'wishlist',
		'alerts',
		'returns',
		'import',
	],
	chat: ['visitor_chat', 'guest_chat', 'inbox', 'assignment', 'import'],
	growth: ['visitor_analytics', 'import'],
};

/**
 * The website itself: its business.json says it is a US shop, so national phone numbers take +1 (K12).
 * @param {Request} request
 */
const website = async (request) =>
	new URL(request.url).pathname === '/.well-known/business.json'
		? Response.json({ version: 1, name: 'Example Shop', country: 'US', timeZone: 'UTC' })
		: new Response('Not found', { status: 404 });

/** @param {string} prefix @param {string} hex */
const idOf = (prefix, hex) => `${prefix}_${hex}`;

describe('importing an example shop into Accounts, Ecommerce, Chat and Growth (K10, ss-import)', () => {
	/** @type {import('./helpers.js').System} */
	let sys;
	let websiteId = '';
	/** @type {Record<string, { browser: string, server: string }>} */
	const tokens = {};
	/** The merchant database of each product. @type {Record<string, import('mongodb').Db>} */
	const databases = {};
	/** @type {Awaited<ReturnType<typeof sourceAndFolder>>} */
	let source;
	/** @type {typeof globalThis.fetch} */
	let fetch;
	/** @type {Record<string, { url: string, token: string }>} */
	let products;

	/**
	 * A call of the merchant's server to a product with its server token.
	 * @param {ProductKey} key @param {string} method @param {string} route @param {unknown} [body]
	 * @param {Record<string, string>} [headers]
	 */
	const server = (key, method, route, body, headers = {}) =>
		sys.call(method, route, {
			base: BASES[key],
			token: tokens[key]?.server,
			...(body === undefined ? {} : { body }),
			headers,
		});

	/**
	 * Every record the import wrote, as stored (without the database's own `_id` and the time of the last write), by
	 * product and collection.
	 */
	const snapshot = async () => {
		/** @type {Record<string, unknown[]>} */
		const all = {};
		for (const [key, db] of Object.entries(databases))
			for (const { name } of await db.listCollections().toArray()) {
				// the activity log and the kit's own bookkeeping grow with every call
				if (/_(activity|idempotency|limits|events)$/.test(name)) continue;
				all[`${key}:${name}`] = (
					await db
						.collection(name)
						.find({}, { projection: { _id: 0 } })
						.toArray()
				)
					.map(({ updatedAt, ...rest }) => (void updatedAt, rest))
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			}
		return all;
	};

	beforeAll(async () => {
		/** @param {any} product @param {any} routes @param {string} url */
		const unit = (product, routes, url) => ({
			createProductInstance: product.createProductInstance,
			createRoutes: routes.createRoutes,
			manifest: product.manifest,
			strings: product.strings,
			url,
		});
		sys = await startSystem({
			unit: { ...unit(accounts, accountsRoutes, BASES.accounts), handlers: { [ORIGIN]: website } },
			extras: [
				unit(ecommerce, ecommerceRoutes, BASES.ecommerce),
				unit(chat, chatRoutes, BASES.chat),
				unit(growth, growthRoutes, BASES.growth),
			],
		});
		fetch = fetchInto(sys);
		for (const base of Object.values(BASES)) await sys.connect({ base });
		const m = await sys.merchant('owner@example-shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const key of /** @type {ProductKey[]} */ (Object.keys(BASES))) {
			await sys.addProduct(m.merchantId, websiteId, key);
			tokens[key] = await sys.tokens(m.merchantId, websiteId, key);
		}
		await sys.addCredits(m.merchantId, 100);
		for (const key of /** @type {ProductKey[]} */ (Object.keys(BASES))) {
			// opening the dashboard also reads the website's business.json
			const cookie = await sys.adminSession(await sys.owner(), websiteId, key);
			const saved = await sys.dashboard(
				cookie,
				'PUT',
				`/v1/dashboard/websites/${websiteId}/features`,
				{ on: FEATURES[key] },
				BASES[key],
			);
			expect(saved.status, `${key}: ${JSON.stringify(saved.json)}`).toBe(200);
			databases[key] = await sys.connectDatabase(cookie, websiteId, BASES[key]);
		}
		products = Object.fromEntries(
			Object.entries(BASES).map(([key, url]) => [key, { url, token: String(tokens[key]?.server) }]),
		);
		source = await sourceAndFolder();
		await seedShop(source.db);
	});
	afterAll(async () => {
		await source?.close();
		await sys?.stop();
	});

	it('dry-runs the shop: the settings that would change and every refused record listed, nothing written', async () => {
		const manifest = await read({ mapping: SHOP_MAPPING, db: source.db, dir: source.dir });
		expect(manifest.targets).toHaveLength(20);
		const dry = await send({ dir: source.dir, products, dryRun: true, fetch });
		expect(dry).toMatchObject({ dryRun: true, ok: false, finished: [] });
		// read from the old shop, written explicitly even where it equals the built-in default (RT-15)
		expect(dry.settings.changes.map((change) => [change.key, change.from, change.to, change.source])).toEqual([
			['checkout.numberPrefix', '', 'EX-', 'built-in'],
			['catalog.currency', 'USD', 'USD', 'built-in'],
			['catalog.mediaBaseUrl', '', 'https://cdn.example.com', 'built-in'],
		]);
		// a first dry run into an empty website checks each record on its own: what names records of earlier files, or
		// a setting the run would write first (the order number's prefix), is refused until the real run writes them
		const refused = dry.steps.flatMap((step) =>
			step.failed.map((failed) => [step.file, failed.line, failed.errors.map((error) => error.path)]),
		);
		expect(refused).toEqual([
			['02-accounts.users.ndjson', 3, ['/role']],
			['04-ecommerce.categories.ndjson', 2, ['/sizeChartId']],
			['05-ecommerce.brands.ndjson', 1, ['/categoryIds']],
			[
				'07-ecommerce.products.ndjson',
				1,
				[
					'/categoryIds',
					'/brandId',
					`/variants/0/attributes/${idOf('att', shopHex(11))}`,
					`/variants/1/attributes/${idOf('att', shopHex(11))}`,
					'/variants',
				],
			],
			['07-ecommerce.products.ndjson', 2, ['/categoryIds', '/brandId']],
			['08-ecommerce.deals.ndjson', 1, ['/scope/productIds']],
			['10-ecommerce.orders.ndjson', 1, ['/number']],
			['10-ecommerce.orders.ndjson', 2, ['/number']],
			['10-ecommerce.orders.ndjson', 3, ['/number']],
			['18-chat.conversations.ndjson', 1, ['/assignedTo']],
			['19-chat.messages.ndjson', 1, ['/conversationId']],
			['19-chat.messages.ndjson', 2, ['/conversationId']],
		]);
		expect(dry.steps.find((step) => step.collection === 'users')?.failed[0]?.errors[0]?.message).toBe(
			'There is no such role: member. Import the roles first.',
		);
		// every other record passed its checks; nothing was written, the settings stay as they were
		expect(dry.steps.reduce((sum, step) => sum + step.inserted + step.failed.length, 0)).toBe(
			manifest.targets.reduce((sum, target) => sum + target.records, 0),
		);
		for (const key of /** @type {ProductKey[]} */ (Object.keys(BASES))) {
			const status = await server(key, 'GET', '/v1/import/status');
			expect(
				Object.values(status.json.imported).every((count) => count === 0),
				key,
			).toBe(true);
		}
		const settings = await server('ecommerce', 'GET', '/v1/settings');
		const checkout = settings.json.features.find((/** @type {{ key: string }} */ feature) => feature.key === 'checkout');
		expect(checkout.values.numberPrefix).toMatchObject({ value: '' });
	});

	it('imports for real: the settings first, every collection in order, each product finished after its last file', async () => {
		const real = await send({ dir: source.dir, products, fetch });
		expect(real.ok, JSON.stringify(real.steps.filter((step) => step.failed.length > 0))).toBe(true);
		expect(real.settings).toMatchObject({ refused: [] });
		const manifest = JSON.parse(await readFile(path.join(source.dir, 'manifest.json'), 'utf8'));
		expect(real.steps.map((step) => [step.file, step.inserted, step.updated])).toEqual(
			manifest.targets.map((/** @type {{ file: string, records: number }} */ target) => [target.file, target.records, 0]),
		);
		// in import order; Ecommerce derives what the shop counts (sold and rating only where order lines and reviews
		// moved), Chat numbers each conversation's messages by time
		expect(real.finished).toEqual([
			{ product: 'accounts', summary: { finished: true, usersWithUnknownRole: 0, requestsWithUnknownUser: 0 } },
			{
				product: 'ecommerce',
				summary: {
					finished: true,
					categoriesChecked: 2,
					categoriesChanged: 1,
					categoryProblems: { orphans: [], cycles: [], tooDeep: [] },
					productsChecked: 2,
					productsChanged: 0,
					customersUpdated: 2,
					loyaltyUpdated: 0,
					productsSoldRatingUpdated: 1,
					serialsSold: 0,
					serialsMissing: 0,
					serialsOnOtherOrders: 0,
					countersSet: 1,
				},
			},
			{ product: 'chat', summary: { finished: true, conversations: 1, renumbered: 2, updated: 1 } },
			{ product: 'growth', summary: { finished: true } },
		]);
	});

	it('verifies the counts and the sums of every product', async () => {
		const report = await verify({ dir: source.dir, products, fetch });
		expect(report.steps.filter((step) => !step.match)).toEqual([]);
		expect(report.totals.filter((total) => !total.match)).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.steps.filter((step) => step.counted !== null).map((step) => [step.collection, step.counted])).toEqual([
			['products', 2],
			['orders', 3],
			['conversations', 1],
		]);
		expect(Object.fromEntries(report.totals.map((total) => [`${total.product} ${total.key}`, total.actual]))).toMatchObject({
			'accounts users.staff': 2,
			'accounts users.role.member': 1,
			'ecommerce stock.units': 17,
			'ecommerce customers': 2,
			'ecommerce orders.delivered.total': 3000,
			'ecommerce orders.cancelled.total': 5500,
			'ecommerce loyalty.points': 35,
			'chat messages': 2,
			'growth visits': 200,
		});
	});

	it('reads back through the products’ own routes', async () => {
		// a product page: the derived price, the category trail, the size chart; sold and rating counted from the moved
		// order lines and review
		const tee = await server('ecommerce', 'GET', '/v1/shop/products/cotton-tee');
		expect(tee.status, JSON.stringify(tee.json)).toBe(200);
		expect(tee.json).toMatchObject({
			name: 'Cotton tee',
			price: 2500,
			rating: { average: 5, count: 1 },
			brand: { slug: 'northwind' },
			breadcrumb: [{ slug: 'clothing' }, { slug: 'tops' }],
		});
		expect(tee.json.sizeChart).toMatchObject({ name: 'Tops' });
		// no order line or review of the tote moved: the old shop's numbers stay
		const tote = await server('ecommerce', 'GET', '/v1/shop/products/canvas-tote');
		expect(tote.json).toMatchObject({ price: 1500, rating: { average: 4, count: 3 } });
		const stored = await databases.ecommerce
			?.collection('ss_ecommerce_products')
			.find({}, { projection: { _id: 0, slug: 1, sold: 1 } })
			.sort({ slug: 1 })
			.toArray();
		expect(stored).toEqual([
			{ slug: 'canvas-tote', sold: 9 },
			{ slug: 'cotton-tee', sold: 1 },
		]);

		// an order by its number: the guest's phone read as a US number (business.json), the merged customer
		const found = await server('ecommerce', 'GET', '/v1/orders?q=EX-2026-000102');
		expect(found.json.items.map((/** @type {{ id: string }} */ order) => order.id)).toEqual([idOf('ord', SHOP_IDS.confirmed)]);
		const order = await server('ecommerce', 'GET', `/v1/orders/${idOf('ord', SHOP_IDS.confirmed)}`);
		expect(order.json).toMatchObject({
			number: 'EX-2026-000102',
			status: 'confirmed',
			customer: { customerId: idOf('cus', SHOP_IDS.guest), phone: '+15550100002' },
			payment: { method: 'bank_transfer', state: 'paid', paid: 3000 },
			customerFlags: { orderCount: 2 },
		});

		// a member's points: the earn and the bonus rebuilt as lots
		const points = await server('ecommerce', 'GET', `/v1/loyalty/accounts/${idOf('usr', SHOP_IDS.member)}`);
		expect(points.json).toMatchObject({ balance: 35 });

		// the conversation: assigned to the imported staff member, its messages numbered in time order
		const conversation = await server('chat', 'GET', `/v1/conversations/${idOf('conv', SHOP_IDS.chat)}`);
		expect(conversation.json.conversation).toMatchObject({
			status: 'resolved',
			assignedTo: { id: idOf('usr', SHOP_IDS.support), name: 'Sam Support' },
			visitor: { kind: 'guest', name: 'Gus Guest', phone: '+15550100002' },
			preview: 'Yes, next week. We will let you know.',
		});
		expect(conversation.json.messages.map((/** @type {{ seq: number, author: string }} */ m) => [m.seq, m.author])).toEqual([
			[1, 'visitor'],
			[2, 'staff'],
		]);

		// the analytics report reads the imported days
		const report = await server('growth', 'GET', '/v1/analytics?from=2026-09-01&to=2026-09-02');
		expect(report.json.totals).toEqual({ visits: 200, pageViews: 500 });
	});

	it('re-runs without changing anything', async () => {
		const before = await snapshot();
		expect(
			['accounts:ss_accounts_users', 'ecommerce:ss_ecommerce_orders', 'chat:ss_chat_messages', 'growth:ss_growth_totals'].map(
				(name) => before[name]?.length,
			),
		).toEqual([3, 3, 2, 2]);
		const again = await send({ dir: source.dir, products, fetch });
		expect(again.ok).toBe(true);
		expect(again.steps.every((step) => step.inserted === 0 && step.failed.length === 0)).toBe(true);
		expect(await snapshot()).toEqual(before);
		expect(await verify({ dir: source.dir, products, fetch })).toMatchObject({ ok: true });
	});

	it('prunes what the source no longer has, a dry run first', async () => {
		// the shopper's stock alert was removed in the old shop since the last read
		await source.db.collection('stockalerts').deleteOne({ _id: new ObjectId(SHOP_IDS.alert) });
		await read({ mapping: SHOP_MAPPING, db: source.db, dir: source.dir });
		const pruned = (/** @type {Awaited<ReturnType<typeof send>>} */ report) =>
			report.steps.filter((step) => (step.pruned?.removed ?? 0) > 0).map((step) => [step.collection, step.pruned]);
		const dry = await send({ dir: source.dir, products, dryRun: true, prune: true, fetch });
		expect(pruned(dry)).toEqual([['alerts', { removed: 1, keys: [idOf('alr', SHOP_IDS.alert)] }]]);
		expect(await databases.ecommerce?.collection('ss_ecommerce_alerts').countDocuments({})).toBe(1);
		const real = await send({ dir: source.dir, products, prune: true, fetch });
		expect(pruned(real)).toEqual([['alerts', { removed: 1, keys: [idOf('alr', SHOP_IDS.alert)] }]]);
		expect(await databases.ecommerce?.collection('ss_ecommerce_alerts').countDocuments({})).toBe(0);
		expect(await verify({ dir: source.dir, products, fetch })).toMatchObject({ ok: true });
	});

	it('lets an imported member sign in with the old shop’s password, and the old guest cookie open the chat', async () => {
		const signedIn = await server(
			'accounts',
			'POST',
			'/v1/sign-in/password',
			{ email: 'mia@example.com', password: SHOP_PASSWORDS.member },
			VISITOR,
		);
		expect(signedIn.json.status, JSON.stringify(signedIn.json)).toBe('signed_in');
		const chatState = await sys.call('GET', '/v1/chat', {
			base: BASES.chat,
			token: tokens.chat?.browser,
			origin: ORIGIN,
			headers: { 'ss-guest': SHOP_GUEST_COOKIE },
		});
		expect(chatState.json.messages.map((/** @type {{ text: string }} */ m) => m.text)).toEqual([
			'Will the blue tee be back?',
			'Yes, next week. We will let you know.',
		]);
	});
});
