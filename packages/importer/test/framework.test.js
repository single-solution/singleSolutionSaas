import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '@ss/contracts';
import {
	SETTINGS_FILE,
	compareKeyTexts,
	defineMapping,
	keyPayloadOf,
	keyTextOf,
	keyValuesOf,
	linesOf,
	main,
	mergePlans,
	pruneCalls,
	read,
	send,
	verify,
} from '../src/index.js';
import { fakeProduct, freshDb, removeDir, tempDir } from './helpers.js';

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await /** @type {() => Promise<unknown>} */ (cleanups.pop())();
});

/** @param {number} n */
const oid = (n) => new ObjectId(`64b0c0ffee${String(n).padStart(14, '0')}`);
/** @param {number} n */
const hex = (n) => oid(n).toHexString();

/** A store-like source: staff and customers who share a phone, one brand in two categories, embedded messages. */
const SOURCE = {
	staff: [{ _id: oid(1), phone: '07700900111', name: 'Ali at the desk', hash: '$2b$10$staff' }],
	customers: [
		{ _id: oid(2), phone: '+447700900111', name: 'Ali' },
		{ _id: oid(3), phone: '+447700900222', name: 'Sara' },
	],
	brands: [
		{ _id: oid(4), slug: 'acme', categories: ['phones'] },
		{ _id: oid(5), slug: 'acme', categories: ['tablets'] },
		{ _id: oid(6), slug: 'zeta', categories: [] },
	],
	products: [
		{ _id: oid(7), name: 'Acme One', brand: 'acme' },
		{ _id: oid(8), name: 'Nobody', brand: 'gone' },
	],
	inquiries: [
		{ _id: oid(9), messages: [{ text: 'Hello' }, { text: 'Still there?' }] },
		{ _id: oid(10), messages: [] },
	],
	points: [
		{ _id: oid(11), customer: oid(2), balance: 50 },
		{ _id: oid(12), customer: oid(3), balance: 25 },
	],
};

/** @param {string} phone */
const digits = (phone) => phone.replace(/\D/g, '').slice(-10);

const SHOP = defineMapping({
	name: 'framework',
	description: 'Test mapping of every framework feature.',
	steps: [
		{
			product: 'accounts',
			collection: 'users',
			source: 'staff',
			prefix: 'usr',
			mergeKey: (doc) => digits(doc.phone),
			map: (doc, ctx) => ({ id: ctx.id('usr', doc._id), name: doc.name, passwordHash: doc.hash, role: 'staff' }),
		},
		{
			product: 'accounts',
			collection: 'users',
			source: 'customers',
			prefix: 'usr',
			mergeKey: (doc) => digits(doc.phone),
			// the customer's id wins; the staff member's password and role stay
			merge: (kept, next) => ({ ...kept, ...next, passwordHash: kept.passwordHash, role: kept.role }),
			map: (doc, ctx) => ({ id: ctx.id('usr', doc._id), name: doc.name, phone: doc.phone }),
			sums: () => ({ people: 1 }),
		},
		{
			product: 'ecommerce',
			collection: 'brands',
			source: 'brands',
			prefix: 'brd',
			mergeKey: (doc) => doc.slug,
			merge: (kept, next) => ({
				...kept,
				categories: [.../** @type {string[]} */ (kept.categories), .../** @type {string[]} */ (next.categories)],
			}),
			lookups: { 'brand-slugs': (record) => String(record.slug) },
			map: (doc, ctx) => ({ id: ctx.id('brd', doc._id), slug: doc.slug, categories: doc.categories }),
		},
		{
			product: 'ecommerce',
			collection: 'products',
			source: 'products',
			prefix: 'prd',
			lookups: { 'product-names': () => null },
			map: (doc, ctx) => ({ id: ctx.id('prd', doc._id), name: doc.name, brandId: ctx.lookup('brand-slugs', doc.brand) }),
			countPath: '/v1/products/count',
		},
		{
			product: 'chat',
			collection: 'conversations',
			source: 'inquiries',
			prefix: 'conv',
			map: (doc, ctx) => (doc.messages.length === 0 ? null : { id: ctx.id('conv', doc._id) }),
		},
		{
			product: 'chat',
			collection: 'messages',
			source: 'inquiries',
			prefix: 'msg',
			// one record per embedded message
			map: (doc, ctx) =>
				doc.messages.map((/** @type {{ text: string }} */ message, /** @type {number} */ i) => ({
					id: `msg_${hexOf(doc._id).slice(0, 22)}${String(i).padStart(2, '0')}`,
					conversationId: ctx.ref('inquiries', doc._id),
					text: message.text,
				})),
		},
		{
			product: 'ecommerce',
			collection: 'loyalty',
			source: 'points',
			prefix: 'loy',
			key: ['customerId'],
			map: (doc, ctx) => ({ customerId: ctx.ref('customers', doc.customer), balance: doc.balance }),
			sums: (record) => ({ 'loyalty.points': Number(record.balance) }),
		},
	],
	settings: async () => ({ ecommerce: { settings: { 'checkout.channels': ['whatsapp'] } } }),
});

/** @param {unknown} id */
const hexOf = (id) => /** @type {ObjectId} */ (id).toHexString();

/** The source in a fresh database, and an empty folder. */
const prepare = async () => {
	const source = await freshDb();
	for (const [name, docs] of Object.entries(SOURCE)) await source.db.collection(name).insertMany(docs);
	const dir = await tempDir();
	cleanups.push(async () => {
		await source.db.dropDatabase();
		await source.client.close();
		await removeDir(dir);
	});
	return { source, dir };
};

/** @param {string} dir @param {string} file */
const recordsOf = async (dir, file) => linesOf(await readFile(path.join(dir, file), 'utf8')).map((line) => JSON.parse(line.text));

describe('the import framework (IMP-21)', () => {
	it('merges across steps, follows a merge that changes the key, fills lookup tables and maps one to many', async () => {
		const { source, dir } = await prepare();
		const manifest = await read({ mapping: SHOP, db: source.db, dir, now: () => 0 });
		expect(manifest.targets.map((t) => [t.file, t.key, t.records])).toEqual([
			['01-accounts.users.ndjson', ['id'], 2],
			['02-ecommerce.brands.ndjson', ['id'], 2],
			['03-ecommerce.products.ndjson', ['id'], 2],
			['04-chat.conversations.ndjson', ['id'], 1],
			['05-chat.messages.ndjson', ['id'], 2],
			['06-ecommerce.loyalty.ndjson', ['customerId'], 2],
		]);
		expect(manifest.targets[2]).toMatchObject({ countPath: '/v1/products/count' });
		expect(manifest.steps.map((step) => [step.source, step.read, step.records, step.merged, step.skipped])).toEqual([
			['staff', 1, 1, 0, 0],
			['customers', 2, 1, 1, 0],
			['brands', 3, 2, 1, 0],
			['products', 2, 2, 0, 0],
			['inquiries', 2, 1, 0, 1],
			['inquiries', 2, 2, 0, 1],
			['points', 2, 2, 0, 0],
		]);
		// the staff member and the customer on one phone are one user with the customer's id
		expect(await recordsOf(dir, '01-accounts.users.ndjson')).toEqual([
			{ id: `usr_${hex(2)}`, name: 'Ali', phone: '+447700900111', passwordHash: '$2b$10$staff', role: 'staff' },
			{ id: `usr_${hex(3)}`, name: 'Sara', phone: '+447700900222' },
		]);
		expect(await recordsOf(dir, '02-ecommerce.brands.ndjson')).toEqual([
			{ id: `brd_${hex(4)}`, slug: 'acme', categories: ['phones', 'tablets'] },
			{ id: `brd_${hex(6)}`, slug: 'zeta', categories: [] },
		]);
		expect((await recordsOf(dir, '03-ecommerce.products.ndjson')).map((record) => record.brandId)).toEqual([
			`brd_${hex(4)}`,
			null,
		]);
		expect((await recordsOf(dir, '05-chat.messages.ndjson')).map((record) => [record.conversationId, record.text])).toEqual([
			[`conv_${hex(9)}`, 'Hello'],
			[`conv_${hex(9)}`, 'Still there?'],
		]);
		expect(await recordsOf(dir, '06-ecommerce.loyalty.ndjson')).toEqual([
			{ customerId: `usr_${hex(2)}`, balance: 50 },
			{ customerId: `usr_${hex(3)}`, balance: 25 },
		]);
		const idmap = JSON.parse(await readFile(path.join(dir, 'idmap.json'), 'utf8'));
		// the staff document follows its merge to the customer's id; the second step reading inquiries does not overwrite
		expect(idmap[`staff/${hex(1)}`]).toBe(`usr_${hex(2)}`);
		expect(idmap[`brands/${hex(5)}`]).toBe(`brd_${hex(4)}`);
		expect(idmap[`inquiries/${hex(9)}`]).toBe(`conv_${hex(9)}`);
		expect(idmap[`points/${hex(11)}`]).toBe(`usr_${hex(2)}`);
		expect(manifest.totals).toEqual({ accounts: { people: 1 }, ecommerce: { 'loyalty.points': 75 } });
		expect(manifest.settings).toBe(SETTINGS_FILE);
		expect(JSON.parse(await readFile(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual({
			ecommerce: { settings: { 'checkout.channels': ['whatsapp'] } },
		});
	});

	it('refuses records without their key and two records with one key', async () => {
		const { source, dir } = await prepare();
		const step = { product: 'ecommerce', collection: 'loyalty', source: 'points', prefix: 'loy', key: ['customerId'] };
		await expect(
			read({
				mapping: defineMapping({ name: 'nokey', description: '', steps: [{ ...step, map: () => ({}) }] }),
				db: source.db,
				dir,
			}),
		).rejects.toThrow(/without its key \(customerId\)/);
		await expect(
			read({
				mapping: defineMapping({
					name: 'twice',
					description: '',
					steps: [{ ...step, map: () => ({ customerId: 'cus_1' }) }],
				}),
				db: source.db,
				dir,
			}),
		).rejects.toThrow(/two records have the key cus_1/);
	});
});

describe('keys and prune ranges', () => {
	it('match the products’ key texts and order', () => {
		expect(keyValuesOf({ id: 'usr_0123456789abcdef01234567' }, ['id'])).toEqual(['usr_0123456789abcdef01234567']);
		expect(keyValuesOf({ id: 'nope' }, ['id'])).toBeNull();
		expect(keyValuesOf(null, ['id'])).toBeNull();
		expect(keyValuesOf({ day: '2024-01-01', part: 0 }, ['day', 'part'])).toEqual(['2024-01-01', 0]);
		expect(keyValuesOf({ day: '2024-01-01', part: -1 }, ['day', 'part'])).toBeNull();
		expect(keyTextOf(['2024-01-01', 0])).toBe('2024-01-01\u001f0');
		expect(keyPayloadOf(['id'], ['x'])).toBe('x');
		expect(keyPayloadOf(['day', 'part'], ['2024-01-01', 0])).toEqual({ day: '2024-01-01', part: 0 });
		// UTF-8 byte order, as MongoDB compares strings (not JavaScript's UTF-16 order)
		expect(['～', '\u{1f600}', 'b', 'a'].sort(compareKeyTexts)).toEqual(['a', 'b', '～', '\u{1f600}']);
	});

	it('cut the kept keys into sorted ranges of at most 1,000', () => {
		const lines = Array.from({ length: IMPORT_LIMITS.records + 1 }, (_, i) => ({
			text: JSON.stringify({ customerId: `cus_${String(IMPORT_LIMITS.records - i).padStart(5, '0')}`, x: 1 }),
		}));
		const target = { product: 'ecommerce', collection: 'loyalty', key: ['customerId'], file: 'x', records: lines.length };
		const calls = pruneCalls(target, [...lines, { text: JSON.stringify({ nokey: true }) }]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ through: 'cus_00999' });
		expect(calls[0]).not.toHaveProperty('after');
		expect(/** @type {unknown[]} */ (calls[0]?.keep)).toHaveLength(IMPORT_LIMITS.records);
		expect(calls[1]).toEqual({ keep: ['cus_01000'], after: 'cus_00999' });
		expect(pruneCalls(target, [])).toEqual([{ keep: [] }]);
		const days = { product: 'growth', collection: 'totals', key: ['day', 'part'], file: 'x', records: 1 };
		expect(pruneCalls(days, [{ text: JSON.stringify({ day: '2024-01-01', part: 0 }) }])).toEqual([
			{ keep: [{ day: '2024-01-01', part: 0 }] },
		]);
	});
});

describe('send: settings, prune and the final pass', () => {
	/** Read the shop source and a fake product per product id (one shared fake answers every product). */
	const sendSetup = async (/** @type {Parameters<typeof fakeProduct>[0]} */ options = {}) => {
		const { source, dir } = await prepare();
		await read({ mapping: SHOP, db: source.db, dir });
		const product = fakeProduct({ keys: { loyalty: ['customerId'] }, ...options });
		const target = { url: 'https://shop.test', token: product.token };
		const products = { accounts: target, ecommerce: target, chat: target };
		/** @type {number[]} */
		const slept = [];
		const sleep = async (/** @type {number} */ ms) => void slept.push(ms);
		return { dir, product, products, slept, sleep };
	};

	it('lists the settings that would change on a dry run, then writes them explicitly, waiting when asked', async () => {
		const { dir, product, products, slept, sleep } = await sendSetup({ busyOnce: true });
		const table = {
			ecommerce: {
				format: { currency: 'EUR', locale: 'en' },
				settings: { 'checkout.guests': true, 'alerts.channels': ['whatsapp'], 'checkout.nope': 1, nodot: 1 },
				lists: { couriers: [{ key: 'post' }], missing: [] },
			},
			payments: { settings: { 'cards.on': true } },
		};
		const dry = await send({ dir, products, dryRun: true, settings: table, fetch: product.fetch, sleep });
		expect(dry.ok).toBe(false);
		expect(dry.settings).toEqual({
			changes: [
				{ product: 'ecommerce', kind: 'format', key: 'currency', from: 'USD', to: 'EUR', source: 'default' },
				// read from the store, over its product default: written explicitly (RT-15)
				{
					product: 'ecommerce',
					kind: 'setting',
					key: 'checkout.channels',
					from: ['email'],
					to: ['whatsapp'],
					source: 'default',
				},
				{ product: 'ecommerce', kind: 'list', key: 'couriers', from: [], to: [{ key: 'post' }], source: null },
			],
			unchanged: 2,
			refused: [
				{ product: 'ecommerce', kind: 'setting', key: 'alerts.channels', message: 'The feature alerts is off.' },
				{ product: 'ecommerce', kind: 'setting', key: 'checkout.nope', message: 'No such setting.' },
				{ product: 'ecommerce', kind: 'setting', key: 'nodot', message: 'No such setting.' },
				{ product: 'ecommerce', kind: 'list', key: 'missing', message: 'No such list.' },
				{ product: 'payments', kind: 'setting', key: '*', message: 'No address or server token for payments.' },
			],
		});
		expect(product.calls.filter((call) => call.method === 'PUT')).toEqual([]);
		const real = await send({
			dir,
			products,
			settings: { ecommerce: { ...table.ecommerce, settings: { 'checkout.guests': 'bad' } } },
			fetch: product.fetch,
			sleep,
		});
		expect(slept).toEqual([2000]);
		expect(product.format).toMatchObject({ currency: 'EUR' });
		expect(product.lists.couriers).toEqual([{ key: 'post' }]);
		expect(product.features.checkout?.values.channels).toEqual({ value: ['whatsapp'], source: 'website' });
		expect(real.settings.refused).toEqual([
			{ product: 'ecommerce', kind: 'setting', key: 'checkout.guests', message: 'The value is not valid. is not a list' },
			{ product: 'ecommerce', kind: 'list', key: 'missing', message: 'No such list.' },
		]);
		// again: nothing left to change
		const again = await send({ dir, products, dryRun: true, fetch: product.fetch, sleep });
		expect(again.settings).toEqual({ changes: [], unchanged: 1, refused: [] });
		expect(mergePlans([null, undefined, { a: { lists: { x: 1 } } }, { a: { lists: { y: 2 } } }])).toEqual({
			a: { lists: { x: 1, y: 2 } },
		});
	});

	it('prunes what the source no longer has on the final pass, a dry run first', async () => {
		const { dir, product, products, sleep } = await sendSetup({ pruneBatch: 1 });
		await send({ dir, products, fetch: product.fetch, sleep });
		// records an earlier import wrote that the store deleted since
		const users = /** @type {Map<string, Record<string, unknown>>} */ (product.stored.get('users'));
		users.set('usr_0000000000000000000000aa', { id: 'usr_0000000000000000000000aa' });
		users.set('usr_ffffffffffffffffffffffff', { id: 'usr_ffffffffffffffffffffffff' });
		const loyalty = /** @type {Map<string, Record<string, unknown>>} */ (product.stored.get('loyalty'));
		loyalty.set('cus_gone', { customerId: 'cus_gone' });
		const dry = await send({ dir, products, dryRun: true, prune: true, fetch: product.fetch, sleep });
		expect(dry.steps.find((step) => step.collection === 'users')?.pruned).toEqual({
			removed: 2,
			keys: ['usr_0000000000000000000000aa', 'usr_ffffffffffffffffffffffff'],
		});
		expect(users.size).toBe(4);
		const real = await send({
			dir,
			products,
			prune: true,
			only: ['accounts.users', 'ecommerce.loyalty'],
			fetch: product.fetch,
			sleep,
		});
		expect(real.steps.map((step) => [step.collection, step.pruned?.removed])).toEqual([
			['users', 2],
			['loyalty', 1],
		]);
		expect([...users.keys()].sort()).toEqual([`usr_${hex(2)}`, `usr_${hex(3)}`]);
		expect([...loyalty.keys()].sort()).toEqual([`usr_${hex(2)}`, `usr_${hex(3)}`]);
		// only the chosen products finish
		expect(real.finished.map((entry) => entry.product)).toEqual(['accounts', 'ecommerce']);
		const prunes = product.calls.filter((call) => call.path.endsWith('/prune') && !call.dryRun);
		// at most one removal a call here: the same range again while the product says there is more
		expect(prunes.map((call) => call.path)).toEqual([
			'/v1/import/users/prune',
			'/v1/import/users/prune',
			'/v1/import/loyalty/prune',
		]);
	});

	it('finishes each product right after its last file, again with ?after=<next> while it answers more', async () => {
		const { dir, product, products, sleep } = await sendSetup({ finishPages: 3 });
		const real = await send({ dir, products, fetch: product.fetch, sleep });
		// the numbers of every page add up; the paging's own more and next are left out
		expect(real.finished).toEqual(
			['accounts', 'chat', 'ecommerce'].map((name) => ({ product: name, summary: { finished: true, notes: 3 } })),
		);
		const finish = ['finish', 'finish page-1', 'finish page-2'];
		expect(
			product.calls.map((call) => (call.path === '/v1/import/finish' ? `finish ${call.body ?? ''}`.trim() : call.path)),
		).toEqual([
			// the settings first (Migration step 2)
			'/v1/settings/checkout.channels',
			'/v1/import/users',
			...finish,
			'/v1/import/brands',
			'/v1/import/products',
			'/v1/import/conversations',
			'/v1/import/messages',
			...finish,
			'/v1/import/loyalty',
			...finish,
		]);
		// a finish that says more without moving on stops the run
		for (const answer of [{ more: true }, { more: true, next: 'same' }]) {
			/** @type {typeof globalThis.fetch} */
			const stuck = async (input, init) =>
				new URL(new Request(input, init).url).pathname === '/v1/import/finish'
					? Response.json(answer)
					: product.fetch(input, init);
			await expect(send({ dir, products, fetch: stuck, sleep })).rejects.toThrow(
				'POST /v1/import/finish of accounts answered more without moving on.',
			);
		}
	});

	it('verifies the sums the steps added up with the product’s', async () => {
		const { dir, product, products, sleep } = await sendSetup({ totals: { people: 1, 'loyalty.points': 70 } });
		await send({ dir, products, fetch: product.fetch, sleep });
		const report = await verify({ dir, products, fetch: product.fetch });
		expect(report.totals).toEqual([
			{ product: 'accounts', key: 'people', expected: 1, actual: 1, match: true },
			{ product: 'ecommerce', key: 'loyalty.points', expected: 75, actual: 70, match: false },
		]);
		expect(report.ok).toBe(false);
	});

	it('runs from the command line', async () => {
		const { dir, product } = await sendSetup({ totals: { people: 1 } });
		const settingsFile = path.join(dir, 'table.json');
		const { writeFile } = await import('node:fs/promises');
		await writeFile(settingsFile, JSON.stringify({ ecommerce: { lists: { couriers: [{ key: 'post' }] } } }));
		let out = '';
		const deps = {
			io: { out: (/** @type {string} */ text) => void (out += text), err: () => {} },
			env: {
				SS_IMPORT_TOKEN_ACCOUNTS: product.token,
				SS_IMPORT_TOKEN_ECOMMERCE: product.token,
				SS_IMPORT_TOKEN_CHAT: product.token,
			},
			fetch: product.fetch,
			connect: async () => {
				throw new Error('not used');
			},
		};
		const args = ['--dir', dir, ...['accounts', 'ecommerce', 'chat'].flatMap((id) => ['--product', `${id}=https://shop.test`])];
		expect(await main(['send', ...args, '--dry-run', '--prune', '--settings', settingsFile], deps)).toBe(0);
		expect(out).toContain('[dry run] settings: 2 to change, 0 unchanged, 0 refused\n');
		expect(out).toContain('  ecommerce list couriers: [] → [{"key":"post"}]\n');
		expect(out).toContain('  ecommerce setting checkout.channels: ["email"] (default) → ["whatsapp"]\n');
		expect(out).toContain('[dry run] accounts users: 2 inserted, 0 updated, 0 failed, 0 to remove\n');
		out = '';
		expect(await main(['send', ...args, '--only', 'accounts.users'], deps)).toBe(0);
		expect(out).toBe('accounts users: 2 inserted, 0 updated, 0 failed\n');
		/** @type {Map<string, Record<string, unknown>>} */ (product.stored.get('users')).set('usr_ffffffffffffffffffffffff', {});
		out = '';
		expect(await main(['send', ...args, '--only', 'accounts.users', '--prune'], deps)).toBe(0);
		expect(out).toContain('accounts users: 0 inserted, 2 updated, 0 failed, 1 removed\n  - usr_ffffffffffffffffffffffff\n');
		out = '';
		expect(await main(['send', ...args, '--settings', path.join(dir, 'missing.json')], deps)).toBe(1);
		out = '';
		await main(['send', ...args, '--settings', settingsFile], deps);
		expect(await main(['verify', ...args], deps)).toBe(1);
		expect(out).toContain('ok   accounts people: read 1, product 1\n');
		expect(out).toContain('DIFF ecommerce loyalty.points: read 75, product ?\n');
		out = '';
		await writeFile(settingsFile, JSON.stringify({ ecommerce: { settings: { 'alerts.channels': [] } } }));
		expect(await main(['send', ...args, '--dry-run', '--settings', settingsFile], deps)).toBe(1);
		expect(out).toContain('  REFUSED ecommerce setting alerts.channels: The feature alerts is off.\n');
	});
});
