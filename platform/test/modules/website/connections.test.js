/**
 * Step 6 of the settings ownership design: ONE database connection and ONE storage connection per website, entered once
 * in the Portal, sealed, write-only, and delivered to every product on the website with its own database name.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateWebsiteConnections } from '@ss/contracts';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { createSecretBox } from '../../../src/infra/crypto.js';
import { closeMongoClients } from '../../../src/testing.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, bootPortal, codeOf } from '../catalog/boot.js';
import { FETCHES_PER_HOUR, checkDatabaseValue, checkStorageValue } from '../../../src/modules/website/connections.js';
import { createOutboundPolicy } from '@ss/net';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
beforeAll(async () => {
	mongo = await startMongo();
}, 180_000);
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const CONFIRM = { password: PASSWORD };
const DB = 'mongodb+srv://app:Sup3rSecret@cluster0.example.net/?retryWrites=true&w=majority';
const DB_NEW = 'mongodb+srv://app2:An0therSecret@cluster9.example.net/?retryWrites=true';
const STORAGE = {
	bucket: 'shop-media',
	region: 'auto',
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	accessKeyId: 'AKIAEXAMPLE',
	secretAccessKey: 'sTorAgeSecret',
	prefix: 'shop/',
};

/**
 * Notes (a database), Chat (a database and optional storage) and Plain (no connection at all) on one website, Notes also
 * on a second website.
 * @param {string} name
 */
const setUp = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	const owner = await h.owner();
	const notes = await h.connect({ ...notesManifest(), needs: { database: true, storage: 'none' } });
	const chat = await h.connect({ ...notesManifest(), id: 'chat', name: 'Chat', needs: { database: true, storage: 'optional' } });
	const plain = await h.connect({ ...notesManifest(), id: 'plain', name: 'Plain', needs: { database: false, storage: 'none' } });
	const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
	const [w1 = '', w2 = ''] = m.websiteIds;
	for (const productId of ['notes', 'chat', 'plain']) {
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId });
		h.clock.advance(1000);
	}
	await owner.post(`/v1/merchants/${m.merchantId}/websites/${w2}/products`, { productId: 'notes' });
	h.clock.advance(1000);
	for (const product of [notes, chat, plain]) product.notices.splice(0);
	const site = (/** @type {string} */ website = w1) => `/v1/merchants/${m.merchantId}/websites/${website}`;
	const fetchAs = (/** @type {typeof notes} */ product, website = w1) =>
		h.productCall(product, 'GET', `/v1/product/websites/${website}/connections`);
	return { h, owner, notes, chat, plain, m, w1, w2, site, fetchAs };
};

const changed = (/** @type {string} */ websiteId, what = 'connections') => ({
	type: 'website.settings_changed',
	websiteId,
	what,
});

describe('what a person may enter', () => {
	const policy = createOutboundPolicy({ allowHosts: [] });
	it('takes a MongoDB connection string and refuses everything else, without repeating it', () => {
		expect(checkDatabaseValue(DB, policy)).toEqual({ ok: true, value: DB });
		expect(checkDatabaseValue(`  ${DB}  `, policy)).toEqual({ ok: true, value: DB });
		for (const bad of [
			'',
			'   ',
			5,
			null,
			'postgres://u:p@host/db',
			'mongodb://u:topsecret@127.0.0.1/db',
			'mongodb://u:topsecret@169.254.169.254/db',
			'mongodb+srv://u:topsecret@x.example.net/?tlsInsecure=true',
			'mongodb+srv://u:topsecret@x.example.net/?tlsCAFile=/etc/passwd',
			`mongodb+srv://u:topsecret@x.example.net/${'a'.repeat(5000)}`,
		]) {
			const checked = checkDatabaseValue(bad, policy);
			expect(checked.ok, String(bad)).toBe(false);
			expect(JSON.stringify(checked)).not.toContain('topsecret');
		}
	});
	it('takes a storage connection with the four required parts and the optional ones, nothing more', () => {
		const ok = checkStorageValue({ ...STORAGE, forcePathStyle: true, ignored: undefined }, policy);
		expect(ok).toEqual({ ok: false, message: 'ignored is not a storage setting.', field: 'ignored' });
		expect(checkStorageValue({ ...STORAGE, forcePathStyle: true }, policy)).toEqual({
			ok: true,
			value: { ...STORAGE, forcePathStyle: true },
		});
		expect(checkStorageValue({ bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 's' }, policy).ok).toBe(true);
		// the public address: trimmed, trailing slashes cut, empty means none
		expect(checkStorageValue({ ...STORAGE, publicBaseUrl: ' https://cdn.example.com/files// ' }, policy)).toEqual({
			ok: true,
			value: { ...STORAGE, publicBaseUrl: 'https://cdn.example.com/files' },
		});
		expect(checkStorageValue({ ...STORAGE, publicBaseUrl: '  ' }, policy)).toEqual({ ok: true, value: STORAGE });
		expect(checkStorageValue({ ...STORAGE, publicBaseUrl: 'ftp://x' }, policy)).toMatchObject({
			ok: false,
			field: 'publicBaseUrl',
		});
		for (const bad of [
			null,
			[],
			'x',
			{ ...STORAGE, bucket: '' },
			{ ...STORAGE, secretAccessKey: undefined },
			{ ...STORAGE, endpoint: 'http://acct.r2.cloudflarestorage.com' },
			{ ...STORAGE, endpoint: 'https://127.0.0.1' },
			{ ...STORAGE, endpoint: 'https://169.254.169.254' },
			{ ...STORAGE, forcePathStyle: 'yes' },
			{ ...STORAGE, publicBaseUrl: 'http://cdn.example.com' },
			{ ...STORAGE, publicBaseUrl: 'https://127.0.0.1' },
			{ ...STORAGE, publicBaseUrl: 'https://cdn.example.com/?x=1' },
			{ ...STORAGE, publicBaseUrl: 'https://cdn.example.com/#top' },
			{ ...STORAGE, publicBaseUrl: 'https://u:p@cdn.example.com' },
			{ ...STORAGE, publicBaseUrl: `https://cdn.example.com/${'a'.repeat(2048)}` },
			{ ...STORAGE, prefix: '/abs/' },
			{ ...STORAGE, prefix: '../up/' },
			{ ...STORAGE, prefix: 'no-slash' },
			{ ...STORAGE, sessionToken: 'x' },
		])
			expect(checkStorageValue(bad, policy).ok, JSON.stringify(bad)).toBe(false);
	});
});

describe('Data and files: the merchant enters the database once', () => {
	it('is sealed at rest, never returned, and asks for the password again', async () => {
		const { h, m, w1, site } = await setUp('conn_seal');
		// nothing set yet
		const empty = await m.client.get(`${site()}/connections`);
		expect(empty.status).toBe(200);
		expect(empty.json).toMatchObject({ version: 0, database: { set: false }, storage: { set: false }, can: { write: true } });
		// a session alone (a stolen cookie) changes nothing
		for (const body of [{ value: DB }, { value: DB, password: 'not the password' }, { value: DB, password: 5 }]) {
			const refused = await m.client.put(`${site()}/connections/database`, body);
			expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
		}
		expect((await m.client.get(`${site()}/connections`)).json.database.set).toBe(false);
		// with the password it is saved
		const saved = await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		expect(saved.status).toBe(200);
		expect(saved.json).toMatchObject({ version: 1, database: { set: true }, storage: { set: false } });
		// no answer of any console route carries the value or any piece of it
		for (const text of [JSON.stringify(saved.json), JSON.stringify((await m.client.get(`${site()}/connections`)).json)]) {
			for (const piece of ['Sup3rSecret', 'cluster0.example.net', 'mongodb+srv', 'app:']) expect(text).not.toContain(piece);
		}
		// at rest the value is sealed (no plaintext anywhere in the Portal database), and bound to its website and name
		const stored = JSON.stringify(await h.db.collection('website_connections').findOne(/** @type {any} */ ({ _id: w1 })));
		expect(stored).not.toContain('Sup3rSecret');
		expect(stored).not.toContain('cluster0');
		for (const collection of ['platform_audit', 'catalog_notices']) {
			const text = JSON.stringify(await h.db.collection(collection).find({}).toArray());
			expect(text, collection).not.toContain('Sup3rSecret');
		}
		const record = /** @type {Record<string, any>} */ (
			await h.db.collection('website_connections').findOne(/** @type {any} */ ({ _id: w1 }))
		);
		expect(record.database.sealed).toMatch(/^ss2\./);
	});

	it('only a signed-in merchant (own website), the Owner and Support change it; Finance and other merchants do not; a product cannot', async () => {
		const { h, m, owner, notes, site } = await setUp('conn_rights');
		const support = await h.admin('support');
		const finance = await h.admin('finance');
		const other = await h.merchant('other@shop.test', ['other.example.com']);
		const body = { value: DB, ...CONFIRM };
		expect(codeOf(await finance.client.put(`${site()}/connections/database`, body))[0]).toBe(403);
		expect(codeOf(await finance.client.get(`${site()}/connections`))[0]).toBe(403);
		expect([401, 403, 404]).toContain(
			other.client ? (await other.client.put(`${site()}/connections/database`, body)).status : 0,
		);
		expect((await other.client.get(`${site()}/connections`)).status).not.toBe(200);
		// a product's assertion is not a person: no write route takes it
		const viaProduct = await h.productCall(notes, 'PUT', `${site()}/connections/database`, body);
		expect([401, 403]).toContain(viaProduct.status);
		expect((await owner.get(`${site()}/connections`)).json.database.set).toBe(false);
		// Support and the Owner can (their own password), and are named in Activity
		expect((await support.client.put(`${site()}/connections/database`, body)).status).toBe(200);
		expect((await owner.put(`${site()}/connections/storage`, { value: STORAGE, ...CONFIRM })).status).toBe(200);
		const view = (await m.client.get(`${site()}/connections`)).json;
		expect(view).toMatchObject({ database: { set: true }, storage: { set: true } });
		const entries = await h.activity('website.connection_saved');
		expect(entries.map((e) => [e.actor.type, e.after.name]).sort()).toEqual([
			['admin', 'database'],
			['admin', 'storage'],
		]);
		for (const entry of entries) expect(JSON.stringify(entry)).not.toContain('Sup3rSecret');
	});

	it('refuses a value that is not a connection and says nothing about the value', async () => {
		const { m, site } = await setUp('conn_validate');
		for (const value of ['postgres://x', 'mongodb://u:p@10.0.0.5/x', '', null, 5, { a: 1 }]) {
			const res = await m.client.put(`${site()}/connections/database`, { value, ...CONFIRM });
			expect(codeOf(res), JSON.stringify(value)).toEqual([422, 'validation_failed']);
		}
		expect(codeOf(await m.client.put(`${site()}/connections/storage`, { value: { bucket: 'b' }, ...CONFIRM }))).toEqual([
			422,
			'validation_failed',
		]);
		expect(codeOf(await m.client.put(`${site()}/connections/elsewhere`, { value: DB, ...CONFIRM }))[0]).toBe(404);
		expect(codeOf(await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM, extra: 1 }))).toEqual([
			422,
			'validation_failed',
		]);
		expect((await m.client.get(`${site()}/connections`)).json.database.set).toBe(false);
	});

	it('every product on the website gets the same connection with its own database name; a product that needs nothing gets nothing', async () => {
		const { h, m, notes, chat, plain, w1, site, fetchAs } = await setUp('conn_names');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		h.clock.advance(1000);
		await m.client.put(`${site()}/connections/storage`, { value: STORAGE, ...CONFIRM });
		const forNotes = await fetchAs(notes);
		const forChat = await fetchAs(chat);
		const forPlain = await fetchAs(plain);
		expect(forNotes.status).toBe(200);
		expect(forNotes.headers.get('cache-control')).toBe('no-store');
		expect(validateWebsiteConnections(forNotes.json).ok).toBe(true);
		expect(validateWebsiteConnections(forChat.json).ok).toBe(true);
		expect(forNotes.json).toMatchObject({ version: 2, database: { uri: DB, dbName: 'ss_notes' }, storage: null });
		expect(forChat.json).toMatchObject({ version: 2, database: { uri: DB, dbName: 'ss_chat' }, storage: STORAGE });
		expect(forPlain.json).toEqual({ version: 2, database: null, storage: null, links: { out: [], in: [] } });
		// both products were told
		expect(notes.notices).toEqual([changed(w1), changed(w1)]);
		expect(chat.notices).toEqual([changed(w1), changed(w1)]);
		expect(plain.notices).toEqual([changed(w1), changed(w1)]);
		// the console shows each product's own database and its folder, never the value
		const view = (await m.client.get(`${site()}/connections`)).json;
		expect(view.products).toEqual([
			{
				productId: 'chat',
				name: 'Chat',
				database: { name: 'ss_chat', overridden: false, state: 'waiting' },
				storage: { folder: `chat/${w1}/`, required: false, state: 'waiting' },
			},
			{
				productId: 'notes',
				name: 'Notes',
				database: { name: 'ss_notes', overridden: false, state: 'waiting' },
				storage: null,
			},
			{ productId: 'plain', name: 'Plain', database: null, storage: null },
		]);
	});

	it('the public address of the files is delivered inside the storage and shown in the console (it is not a secret); a replacement without it drops it', async () => {
		const { m, chat, site, fetchAs } = await setUp('conn_public');
		const PUBLIC = 'https://cdn.example.com/files';
		await m.client.put(`${site()}/connections/storage`, { value: { ...STORAGE, publicBaseUrl: `${PUBLIC}/` }, ...CONFIRM });
		const delivered = await fetchAs(chat);
		expect(validateWebsiteConnections(delivered.json).ok).toBe(true);
		expect(delivered.json.storage).toEqual({ ...STORAGE, publicBaseUrl: PUBLIC });
		const view = (await m.client.get(`${site()}/connections`)).json;
		expect(view.storage).toMatchObject({ set: true, publicBaseUrl: PUBLIC });
		expect(JSON.stringify(view)).not.toContain('sTorAgeSecret');
		// replaced without one: nothing is kept of the old address
		await m.client.put(`${site()}/connections/storage`, { value: STORAGE, ...CONFIRM });
		expect((await m.client.get(`${site()}/connections`)).json.storage).not.toHaveProperty('publicBaseUrl');
		expect((await fetchAs(chat)).json.storage).toEqual(STORAGE);
		const refused = await m.client.put(`${site()}/connections/storage`, {
			value: { ...STORAGE, publicBaseUrl: 'http://cdn.example.com' },
			...CONFIRM,
		});
		expect(codeOf(refused)).toEqual([422, 'validation_failed']);
		expect(refused.json.errors[0].path).toBe('/value/publicBaseUrl');
	});

	it('answers a product only for a website that has it, and only to that product', async () => {
		const { h, owner, chat, plain, notes, w1, w2, m, site, fetchAs } = await setUp('conn_scope');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		// Chat is not on the second website
		expect(codeOf(await fetchAs(chat, w2))).toEqual([404, 'website_not_found']);
		expect(codeOf(await fetchAs(chat, 'nope'))).toEqual([404, 'website_not_found']);
		// the second website has nothing entered: Notes there gets an empty answer
		expect((await fetchAs(notes, w2)).json).toMatchObject({ version: 0, database: null });
		// no assertion, no answer
		expect(codeOf(await h.api.call('GET', `/v1/product/websites/${w1}/connections`))[0]).toBe(401);
		// a product removed from the website is no longer answered
		expect((await fetchAs(plain)).status).toBe(200);
		expect((await owner.del(`${site()}/products/plain`)).status).toBe(200);
		expect(codeOf(await fetchAs(plain))).toEqual([404, 'website_not_found']);
	});

	it('rotation: a changed value reaches every product, which fetch the new one', async () => {
		const { h, m, notes, chat, w1, site, fetchAs } = await setUp('conn_rotate');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		expect((await fetchAs(notes)).json.database.uri).toBe(DB);
		notes.notices.splice(0);
		chat.notices.splice(0);
		h.clock.advance(1000);
		const second = await m.client.put(`${site()}/connections/database`, { value: DB_NEW, ...CONFIRM });
		expect(second.json.version).toBe(2);
		expect(notes.notices).toEqual([changed(w1)]);
		expect(chat.notices).toEqual([changed(w1)]);
		expect((await fetchAs(notes)).json).toMatchObject({ version: 2, database: { uri: DB_NEW, dbName: 'ss_notes' } });
		expect((await fetchAs(chat)).json).toMatchObject({ version: 2, database: { uri: DB_NEW, dbName: 'ss_chat' } });
	});

	it('a product added to the website later gets the connection (and the status says there is one)', async () => {
		const { h, m, owner, w2, site } = await setUp('conn_later');
		await m.client.put(`${site(w2)}/connections/database`, { value: DB, ...CONFIRM });
		const later = await h.connect({
			...notesManifest(),
			id: 'growth',
			name: 'Growth',
			needs: { database: true, storage: 'none' },
		});
		await owner.post(`${site(w2)}/products`, { productId: 'growth' });
		h.clock.advance(1000);
		// its status already shows the version of the connections, so it fetches without any notice
		const status = await h.productCall(later, 'GET', `/v1/product/websites/${w2}/status`);
		expect(status.json.connectionsVersion).toBe(1);
		const got = await h.productCall(later, 'GET', `/v1/product/websites/${w2}/connections`);
		expect(got.json).toMatchObject({ version: 1, database: { uri: DB, dbName: 'ss_growth' } });
	});

	it('the status answer carries the version of the connections; a change raises it for the website only', async () => {
		const { h, m, notes, w1, w2, site } = await setUp('conn_status');
		const version = async (/** @type {string} */ website) =>
			(await h.productCall(notes, 'GET', `/v1/product/websites/${website}/status`)).json.connectionsVersion;
		expect([await version(w1), await version(w2)]).toEqual([0, 0]);
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		expect([await version(w1), await version(w2)]).toEqual([1, 0]);
		await m.client.put(`${site()}/connections/storage`, { value: STORAGE, ...CONFIRM });
		await m.client.post(`${site()}/connections/storage/remove`, CONFIRM);
		expect(await version(w1)).toBe(3);
	});

	it('limits secret fetches to a few an hour per product and website, and logs each', async () => {
		const { h, m, notes, w1, site, fetchAs } = await setUp('conn_limit');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		for (let i = 0; i < FETCHES_PER_HOUR; i += 1) expect((await fetchAs(notes)).status).toBe(200);
		expect(codeOf(await fetchAs(notes))).toEqual([429, 'rate_limited']);
		// another product has its own allowance, and an hour later the first is let in again
		expect(
			(
				await h.productCall(
					await h.connect({ ...notesManifest(), id: 'alerts', name: 'Alerts' }),
					'GET',
					`/v1/product/websites/${w1}/connections`,
				)
			).status,
		).toBe(404);
		h.clock.advance(3_600_001);
		expect((await fetchAs(notes)).status).toBe(200);
		const entries = await h.activity('website.connections_delivered');
		expect(entries.length).toBe(FETCHES_PER_HOUR + 1);
		expect(entries[0]).toMatchObject({
			actor: { type: 'product', id: 'notes' },
			after: { productId: 'notes', version: 1, parts: ['database'] },
		});
	});

	it('a fetch with nothing to deliver is not counted against the limit', async () => {
		const { notes, fetchAs } = await setUp('conn_free');
		for (let i = 0; i < FETCHES_PER_HOUR + 3; i += 1) expect((await fetchAs(notes)).status).toBe(200);
	});

	it('the products report how the value worked and the console shows it per product', async () => {
		const { h, m, notes, chat, w1, site } = await setUp('conn_health');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		const health = (/** @type {typeof notes} */ product, /** @type {unknown} */ body, name = 'database') =>
			h.productCall(product, 'PUT', `/v1/product/websites/${w1}/connections/${name}/health`, body);
		expect((await health(notes, { version: 1, ok: true })).status).toBe(200);
		expect(
			(await health(chat, { version: 1, ok: false, message: 'The database cannot be reached with this connection string.' }))
				.status,
		).toBe(200);
		const row = (/** @type {any} */ view, /** @type {string} */ id) =>
			view.products.find((/** @type {any} */ p) => p.productId === id).database;
		let view = (await m.client.get(`${site()}/connections`)).json;
		expect(row(view, 'notes')).toMatchObject({ state: 'connected' });
		expect(row(view, 'chat')).toMatchObject({
			state: 'test_failed',
			message: 'The database cannot be reached with this connection string.',
		});
		// a new value makes older reports mean nothing: waiting again until the product reports on the new one
		await m.client.put(`${site()}/connections/database`, { value: DB_NEW, ...CONFIRM });
		view = (await m.client.get(`${site()}/connections`)).json;
		expect(row(view, 'notes').state).toBe('waiting');
		expect(row(view, 'chat').state).toBe('waiting');
		await health(notes, { version: 2, ok: true });
		expect(row((await m.client.get(`${site()}/connections`)).json, 'notes').state).toBe('connected');
		// bad reports and other names are refused; a product cannot report for a website it is not on
		expect(codeOf(await health(notes, { version: 2 }))[0]).toBe(422);
		expect(codeOf(await health(notes, { version: 2, ok: true, uri: 'x' }))[0]).toBe(422);
		expect(codeOf(await health(notes, { version: 2, ok: true }, 'elsewhere'))[0]).toBe(404);
		const { w2 } = { w2: 'nope' };
		expect(
			codeOf(
				await h.productCall(chat, 'PUT', `/v1/product/websites/${w2}/connections/database/health`, { version: 1, ok: true }),
			)[0],
		).toBe(404);
		// a long message is cut
		await health(chat, { version: 2, ok: false, message: 'x'.repeat(300) });
		expect(row((await m.client.get(`${site()}/connections`)).json, 'chat').message.length).toBe(300);
	});

	it('removing a connection raises the version, tells the products and stops delivering it; the merchant is e-mailed with no value', async () => {
		const { h, m, notes, w1, site, fetchAs } = await setUp('conn_remove');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		notes.notices.splice(0);
		h.clock.advance(1000);
		expect(codeOf(await m.client.post(`${site()}/connections/database/remove`, {}))[0]).toBe(422);
		const removed = await m.client.post(`${site()}/connections/database/remove`, CONFIRM);
		expect(removed.json).toMatchObject({ version: 2, database: { set: false } });
		expect(notes.notices).toEqual([changed(w1)]);
		expect((await fetchAs(notes)).json).toMatchObject({ version: 2, database: null });
		expect(codeOf(await m.client.post(`${site()}/connections/database/remove`, CONFIRM))[0]).toBe(404);
		expect((await h.activity('website.connection_removed')).length).toBe(1);
		// e-mails: one per change, naming the website and who, never the value
		const mails = h.mailer.sent.filter((mail) => mail.template === 'connection_changed');
		expect(mails.length).toBe(2);
		expect(JSON.stringify(mails)).not.toContain('Sup3rSecret');
		expect(mails[0]).toMatchObject({ to: 'm@shop.test', data: { website: 'shop.example.com', who: 'You' } });
	});

	it('an Owner may name the database of one product (a store that must keep its single database); nobody else', async () => {
		const { h, m, owner, notes, chat, w1, site, fetchAs } = await setUp('conn_names_owner');
		const support = await h.admin('support');
		const names = { notes: 'acme_main' };
		expect(codeOf(await m.client.put(`${site()}/connections/database`, { value: DB, names, ...CONFIRM }))[0]).toBe(403);
		expect(codeOf(await support.client.put(`${site()}/connections/database`, { value: DB, names, ...CONFIRM }))[0]).toBe(403);
		for (const bad of [{ notes: 'has.dot' }, { notes: 'a', chat: 'a' }, { Notes: 'ok_name' }, 'x'])
			expect(
				codeOf(await owner.put(`${site()}/connections/database`, { value: DB, names: bad, ...CONFIRM }))[0],
				JSON.stringify(bad),
			).toBe(422);
		expect((await owner.put(`${site()}/connections/database`, { value: DB, names, ...CONFIRM })).status).toBe(200);
		expect((await fetchAs(notes)).json.database.dbName).toBe('acme_main');
		expect((await fetchAs(chat)).json.database.dbName).toBe('ss_chat');
		expect(
			(await m.client.get(`${site()}/connections`)).json.products.find((/** @type {any} */ p) => p.productId === 'notes')
				.database,
		).toMatchObject({ name: 'acme_main', overridden: true });
		expect((await h.activity('website.connection_saved'))[0]?.after.dbNames).toEqual(names);
		expect(w1).toBeTruthy();
	});

	it('the website removed: its connections are gone', async () => {
		const { h, m, owner, w2, site } = await setUp('conn_forget');
		await m.client.put(`${site(w2)}/connections/database`, { value: DB, ...CONFIRM });
		expect(await h.db.collection('website_connections').countDocuments(/** @type {any} */ ({ _id: w2 }))).toBe(1);
		expect((await owner.del(`${site(w2)}/products/notes`)).status).toBe(200);
		const gone = await owner.del(site(w2), { confirm: 'blog.example.com' });
		expect(gone.status).toBe(200);
		expect(await h.db.collection('website_connections').countDocuments(/** @type {any} */ ({ _id: w2 }))).toBe(0);
	});
});

describe('the Owner re-seals the connections with a new key', () => {
	it('moves them to the new key, then they open with it alone; a wrong previous key is named', async () => {
		const { h, m, w1, site } = await setUp('conn_rekey');
		await m.client.put(`${site()}/connections/database`, { value: DB, ...CONFIRM });
		await m.client.put(`${site()}/connections/storage`, { value: STORAGE, ...CONFIRM });
		cleanups.push(h.close);
		const NEW_KEY = 'new-encryption-key-0123456789abcdef-portal';
		const changing = await bootPortal({
			db: mongo.db('conn_rekey'),
			env: { ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: 'test-encryption-key-0123456789abcdef-portal' },
		});
		cleanups.push(changing.close);
		const owner2 = await changing.owner();
		const first = await owner2.post('/v1/admin/settings/reseal');
		expect(first.json.unreadable).toBe(0);
		// the two connections (with the keys that are re-sealed anyway)
		const second = await owner2.post('/v1/admin/settings/reseal');
		expect(second.json).toMatchObject({ resealed: 0, unreadable: 0 });
		expect(first.json.resealed - second.json.current).toBeLessThan(0);
		const record = /** @type {Record<string, any>} */ (
			await mongo
				.db('conn_rekey')
				.collection('website_connections')
				.findOne(/** @type {any} */ ({ _id: w1 }))
		);
		const box = createSecretBox({ encryptionKey: NEW_KEY });
		expect(
			box.openText(record.database.sealed, {
				aad: { websiteId: w1, name: 'database', v: String(record.database.v), purpose: 'website_connection' },
			}),
		).toBe(DB);
		// a wrong previous key opens nothing: the parts are named with what to do
		const wrong = await bootPortal({
			db: mongo.db('conn_rekey'),
			env: {
				ENCRYPTION_KEY: 'third-encryption-key-0123456789abcdef-portal',
				ENCRYPTION_KEY_PREVIOUS: 'wrong-encryption-key-0123456789abcdef-portal',
			},
		});
		cleanups.push(wrong.close);
		const signIn = await wrong.api.call('POST', '/v1/auth/sign-in', {
			body: { email: 'owner@portal.test', password: PASSWORD },
			idempotencyKey: 'conn-rekey-wrong-sign-in',
		});
		const cookie = (signIn.cookies[0] ?? '').split(';')[0];
		const lost = await wrong.api.call('POST', '/v1/admin/settings/reseal', {
			body: {},
			cookie,
			idempotencyKey: 'conn-rekey-wrong-reseal',
		});
		expect(lost.json.unreadableIn.websiteConnections).toBe(2);
	});
});
