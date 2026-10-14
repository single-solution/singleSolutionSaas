/**
 * A merchant database made before E45: its attribute index `by_slug` (one slug per website) is dropped when the shop
 * connects to it, so the same slug can be defined for two categories, and the attributes saved before E45 become the
 * ones for every category (`categoryId: null`). The upgrade is idempotent and never drops anything else.
 */
import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, it } from 'vitest';
import { upgradeDatabase } from '../adapters/catalog-store.js';
import { ALL, setup } from './helpers.js';

/** The shop's collections in the merchant database. */
const PREFIX = 'ss_ecommerce_';
/** The index of databases made before E45. */
const OLD_INDEX = Object.freeze({ name: 'by_slug', unique: true, partialFilterExpression: { slug: { $type: 'string' } } });

let databases = 0;
/** A new database on the shared MongoDB. */
const freshUri = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/upgrade_${process.pid}_${Date.now()}_${databases}`;
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

/** @param {import('mongodb').Db} db */
const attributeIndexes = async (db) =>
	(await db.collection(`${PREFIX}attributes`).listIndexes().toArray()).map((index) => index.name).sort();

describe('a merchant database made before E45', () => {
	it('drops only the old slug index, once, and marks the attributes without a category as for every category', async () => {
		const db = await open(freshUri());
		const attributes = db.collection(`${PREFIX}attributes`);
		await attributes.createIndex({ websiteId: 1, slug: 1 }, OLD_INDEX);
		await attributes.insertMany([
			{ websiteId: 'web_1', id: 'att_old', slug: 'size', name: 'Size' },
			{ websiteId: 'web_1', id: 'att_new', slug: 'colour', name: 'Colour', categoryId: 'cat_1' },
		]);
		expect(await upgradeDatabase(db, PREFIX)).toEqual({ dropped: [`${PREFIX}attributes.by_slug`], attributes: 1 });
		expect(await attributeIndexes(db)).toEqual(['_id_']);
		expect(await attributes.findOne({ id: 'att_old' })).toMatchObject({ categoryId: null });
		expect(await attributes.findOne({ id: 'att_new' })).toMatchObject({ categoryId: 'cat_1' });
		// again: nothing is left to do
		expect(await upgradeDatabase(db, PREFIX)).toEqual({ dropped: [], attributes: 0 });
	});

	it('leaves a new database, and an index of that name with other keys, as they are', async () => {
		const fresh = await open(freshUri());
		expect(await upgradeDatabase(fresh, PREFIX)).toEqual({ dropped: [], attributes: 0 });
		expect(await fresh.listCollections().toArray()).toEqual([]);
		const other = await open(freshUri());
		await other.collection(`${PREFIX}attributes`).createIndex({ slug: 1, websiteId: 1 }, { name: 'by_slug' });
		expect(await upgradeDatabase(other, PREFIX)).toEqual({ dropped: [], attributes: 0 });
		expect(await attributeIndexes(other)).toEqual(['_id_', 'by_slug']);
	});

	it('takes the same slug for two categories once the shop has connected to it', async () => {
		const uri = freshUri();
		const db = await open(uri);
		const shop = await setup();
		try {
			const attributes = db.collection(`${PREFIX}attributes`);
			await attributes.createIndex({ websiteId: 1, slug: 1 }, OLD_INDEX);
			// an attribute saved before E45: no category
			await attributes.insertOne({
				websiteId: shop.websiteId,
				id: 'att_000000000000000000000001',
				name: 'Material',
				slug: 'material',
				type: 'text',
				choices: [],
				unit: '',
				filterable: false,
				comparable: false,
				sort: 0,
				categoryIds: [],
				on: 'product',
				multiple: false,
				visibility: { when: 'always', ids: [], attributeId: null, value: null },
				card: 'none',
				active: true,
				seo: { title: '', description: '', body: '', faqs: [] },
			});
			await shop.switchOn(ALL);
			await shop.connect('database', uri);
			const shoes = await shop.api('POST', '/v1/categories', { name: 'Shoes' });
			const shirts = await shop.api('POST', '/v1/categories', { name: 'Shirts' });
			const size = { name: 'Size', slug: 'size', type: 'choice' };
			const first = await shop.api('POST', '/v1/attributes', { ...size, choices: ['40', '41'], categoryId: shoes.json.id });
			const second = await shop.api('POST', '/v1/attributes', { ...size, choices: ['S', 'M'], categoryId: shirts.json.id });
			expect([first.status, second.status]).toEqual([201, 201]);
			expect(await attributeIndexes(db)).not.toContain('by_slug');
			const listed = (await shop.api('GET', '/v1/attributes')).json.items;
			expect(listed.find((/** @type {any} */ row) => row.slug === 'material')).toMatchObject({ categoryId: null });
		} finally {
			await shop.product.close();
		}
	});
});
