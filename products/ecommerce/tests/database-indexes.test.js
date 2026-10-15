/**
 * The shop's declared indexes are the truth (the kit's rule, global audit 42): a merchant database made before E45
 * still has the attributes index `by_slug` (one slug per website); when the shop first uses it, the kit drops that
 * retired index and creates `by_category_slug`, so the same slug can be defined for two categories. No record is
 * changed; nothing else in the database is touched.
 */
import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, it } from 'vitest';
import { INDEXES } from '../adapters/product.js';
import { ALL, setup } from './helpers.js';

/** The shop's collections in the merchant database. */
const PREFIX = 'ss_ecommerce_';

let databases = 0;
/** A new database on the shared MongoDB. */
const freshUri = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/indexes_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/** @type {MongoClient[]} */
const clients = [];
/** @param {string} uri */
const open = async (uri) => {
	const client = await new MongoClient(uri).connect();
	clients.push(client);
	return client.db();
};
afterAll(async () => {
	await Promise.all(clients.map((client) => client.close()));
});

/** @param {import('mongodb').Db} db @param {string} name */
const indexNames = async (db, name) =>
	(await db.collection(`${PREFIX}${name}`).listIndexes().toArray()).map((index) => index.name).sort();

describe('a merchant database made before E45', () => {
	it('gets the shop’s declared indexes when the shop first uses it, and takes the same slug for two categories', async () => {
		const uri = freshUri();
		const db = await open(uri);
		const shop = await setup();
		try {
			const attributes = db.collection(`${PREFIX}attributes`);
			await attributes.createIndex(
				{ websiteId: 1, slug: 1 },
				{ name: 'by_slug', unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
			);
			// a collection the shop does not have keeps its indexes
			await db.collection('ss_other_attributes').createIndex({ websiteId: 1, slug: 1 }, { name: 'by_slug', unique: true });
			await shop.switchOn(ALL);
			await shop.connect('database', uri);
			const shoes = await shop.api('POST', '/v1/categories', { name: 'Shoes' });
			const shirts = await shop.api('POST', '/v1/categories', { name: 'Shirts' });
			const size = { name: 'Size', slug: 'size', type: 'choice' };
			const first = await shop.api('POST', '/v1/attributes', { ...size, choices: ['40', '41'], categoryId: shoes.json.id });
			const second = await shop.api('POST', '/v1/attributes', { ...size, choices: ['S', 'M'], categoryId: shirts.json.id });
			expect([first.status, second.status]).toEqual([201, 201]);
			expect(await indexNames(db, 'attributes')).toEqual(
				['_id_', ...INDEXES.filter((index) => index.collection === 'attributes').map((index) => index.name)].sort(),
			);
			expect((await db.collection('ss_other_attributes').listIndexes().toArray()).map((index) => index.name)).toContain(
				'by_slug',
			);
			// the same slug twice in one category is still refused
			const again = await shop.api('POST', '/v1/attributes', { ...size, choices: ['XL'], categoryId: shirts.json.id });
			expect(again.status).toBe(409);
		} finally {
			await shop.product.close();
		}
	});
});

describe('a merchant database made before guests by email (dynamic model §5)', () => {
	it('drops the phone-only guest index for one guest per key, so guests without a phone never clash', async () => {
		const uri = freshUri();
		const db = await open(uri);
		const shop = await setup();
		try {
			await db
				.collection(`${PREFIX}customers`)
				.createIndex(
					{ websiteId: 1, phone: 1 },
					{ name: 'one_guest_per_phone', unique: true, partialFilterExpression: { guest: true } },
				);
			await shop.switchOn(ALL);
			await shop.connect('database', uri);
			await shop.setting('checkout', 'guests', 'on');
			await shop.setting('checkout', 'guestIdentity', 'email');
			await shop.setting('checkout', 'phoneRequired', false);
			const item = await shop.seedProduct({ price: 1000, stock: 10 });
			/** @param {string} email */
			const order = (email) =>
				shop.visitor('POST', '/v1/shop/orders', {
					body: {
						lines: [{ productId: item.id }],
						payment: 'cod',
						address: { name: 'Guest', line1: '1 Main Street', city: 'Springfield' },
						customer: { name: 'Guest', email },
					},
					key: `idx-${email}`,
				});
			const placed = [await order('one@example.com'), await order('two@example.com')];
			expect(placed.map((answer) => answer.status)).toEqual([201, 201]);
			const names = await indexNames(db, 'customers');
			expect(names).toContain('one_guest_per_key');
			expect(names).not.toContain('one_guest_per_phone');
			const guests = await db.collection(`${PREFIX}customers`).find({ guest: true }).toArray();
			expect(guests.map((guest) => [guest.guestKey, guest.phone]).sort()).toEqual([
				['e:one@example.com', ''],
				['e:two@example.com', ''],
			]);
		} finally {
			await shop.product.close();
		}
	});
});
