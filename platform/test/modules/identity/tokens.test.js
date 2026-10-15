import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { createKeyResolver, verifyToken } from '@ss/protocol';
import { createSecretBox } from '../../../src/infra/crypto.js';
import { ADMIN } from '../../../src/texts/console.js';
import { closeMongoClients } from '../../../src/testing.js';
import { createSystemStore } from '../../../src/infra/system.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, PORTAL_URL, bootPortal, codeOf } from '../catalog/boot.js';

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

/** @param {string} name @param {Record<string, string>} [env] */
const setUp = async (name, env) => {
	const h = await bootPortal({ db: mongo.db(name), ...(env ? { env } : {}) });
	cleanups.push(h.close);
	const owner = await h.owner();
	return { h, owner };
};

/**
 * Verify a token the way the product does: offline, against the keys it pinned at connect.
 * @param {Awaited<ReturnType<typeof bootPortal>>} h
 * @param {string} token
 * @param {'browser' | 'server'} kind
 */
const check = (h, token, kind) =>
	verifyToken({
		token,
		keyResolver: createKeyResolver({ jwks: h.portal.shared.keys.publishedJwks() }),
		issuer: PORTAL_URL,
		productId: 'notes',
		kind,
	});

describe('tokens per website × product (PLAN 0.4.4)', () => {
	it('creates both tokens on Add product: browser token in full, server token revealed only on request and logged', async () => {
		const { h, owner } = await setUp('tokens_basics');
		const product = await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const [websiteId] = m.websiteIds;
		const site = `/v1/merchants/${m.merchantId}/websites/${websiteId}`;
		expect((await m.client.get(`${site}/tokens`)).json.items).toEqual([]);
		await owner.post(`${site}/products`, { productId: 'notes' });
		const listed = await m.client.get(`${site}/tokens`);
		expect(listed.json.items).toEqual([
			{
				productId: 'notes',
				name: 'Notes',
				widgetScriptUrl: 'https://notes.example.dev/widget.js',
				widgetScriptLoading: 'async',
				docsUrl: `${product.url}/docs`,
				browserToken: expect.any(String),
				serverToken: { canShow: true },
			},
		]);
		expect(listed.headers.get('cache-control')).toBe('no-store');
		const browser = await check(h, listed.json.items[0].browserToken, 'browser');
		expect(browser).toMatchObject({
			iss: PORTAL_URL,
			websiteId,
			domain: 'shop.example.com',
			productId: 'notes',
			kind: 'browser',
		});
		// the product verifies with the keys it pinned at connect
		const pinned = /** @type {any} */ (product.pinnedJwks());
		expect(
			(
				await verifyToken({
					token: listed.json.items[0].browserToken,
					keyResolver: pinned,
					issuer: PORTAL_URL,
					productId: 'notes',
				})
			).jti,
		).toBe(browser.jti);
		// reveal by an admin: never cached, logged, and the merchant sees it under the Branding name
		const support = await h.admin('support');
		const revealed = await support.client.post(`${site}/tokens/notes/reveal`);
		expect(revealed.status).toBe(200);
		expect(revealed.headers.get('cache-control')).toBe('no-store');
		const server = await check(h, revealed.json.serverToken, 'server');
		expect(server.kind).toBe('server');
		expect(server.jti).not.toBe(browser.jti);
		expect(JSON.stringify(await h.db.collection('identity_product_tokens').find({}).toArray())).not.toContain(
			revealed.json.serverToken,
		);
		const own = await m.client.get(`/v1/merchants/${m.merchantId}/activity`);
		expect(own.json.items.find((/** @type {any} */ e) => e.action === 'token.revealed')).toMatchObject({
			actor: { type: 'admin', id: null, name: 'Single Solution' },
			target: { type: 'website', id: websiteId },
		});
		expect((await m.client.post(`${site}/tokens/notes/reveal`)).json.serverToken).toBe(revealed.json.serverToken);
		// a product that is not on the website
		expect(codeOf(await m.client.post(`${site}/tokens/chat/reveal`))).toEqual([404, 'not_found']);
	});

	it('Finance never sees tokens; merchants see only their own; Owner and Support manage', async () => {
		const { h, owner } = await setUp('tokens_rights');
		await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const other = await h.merchant('o@shop.test', ['other.example.com']);
		const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}`;
		await owner.post(`${site}/products`, { productId: 'notes' });
		const finance = await h.admin('finance');
		expect(codeOf(await finance.client.get(`${site}/tokens`))).toEqual([403, 'forbidden']);
		expect(codeOf(await finance.client.post(`${site}/tokens/notes/reveal`))).toEqual([403, 'forbidden']);
		expect(codeOf(await finance.client.post(`${site}/tokens/notes/regenerate`, { kind: 'server' }))).toEqual([
			403,
			'forbidden',
		]);
		expect(codeOf(await other.client.get(`${site}/tokens`))).toEqual([403, 'forbidden']);
		expect(codeOf(await other.client.post(`${site}/tokens/notes/reveal`))).toEqual([403, 'forbidden']);
		expect((await owner.get(`${site}/tokens`)).status).toBe(200);
		expect((await h.api.call('GET', `${site}/tokens`)).status).toBe(401);
	});

	it('regenerate revokes the old id at once, tells the product, and lists it in the revocations', async () => {
		const { h, owner } = await setUp('tokens_regenerate');
		const product = await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const [websiteId] = m.websiteIds;
		const site = `/v1/merchants/${m.merchantId}/websites/${websiteId}`;
		await owner.post(`${site}/products`, { productId: 'notes' });
		const before = (await m.client.get(`${site}/tokens`)).json.items[0];
		const oldServer = await check(h, (await m.client.post(`${site}/tokens/notes/reveal`)).json.serverToken, 'server');
		h.clock.advance(1000);
		const fresh = await m.client.post(`${site}/tokens/notes/regenerate`, { kind: 'server' });
		expect(fresh.status).toBe(200);
		expect(fresh.json).toMatchObject({ productId: 'notes', kind: 'server' });
		expect((await check(h, fresh.json.token, 'server')).jti).not.toBe(oldServer.jti);
		expect(product.notices.at(-1)).toEqual({ type: 'token.revoked', websiteId });
		h.clock.advance(1000);
		const browser = await owner.post(`${site}/tokens/notes/regenerate`, { kind: 'browser' });
		expect(browser.json.token).not.toBe(before.browserToken);
		expect((await m.client.get(`${site}/tokens`)).json.items[0].browserToken).toBe(browser.json.token);
		expect(codeOf(await owner.post(`${site}/tokens/notes/regenerate`, { kind: 'both' }))).toEqual([422, 'validation_failed']);
		const oldBrowser = await check(h, before.browserToken, 'browser');
		const revocations = await h.productCall(product, 'GET', '/v1/product/revocations');
		expect(revocations.json.tokenIds.sort()).toEqual([oldServer.jti, oldBrowser.jti].sort());
		// the cursor continues from where the product stopped (recent ids repeat for a short lag, never skipped)
		h.clock.advance(60_000);
		const again = await h.productCall(product, 'GET', `/v1/product/revocations?since=${revocations.json.cursor}`);
		expect(again.json.tokenIds).toHaveLength(2);
		const next = await h.productCall(product, 'GET', `/v1/product/revocations?since=${again.json.cursor}`);
		expect(next.json.tokenIds).toEqual([]);
		expect(codeOf(await h.productCall(product, 'GET', '/v1/product/revocations?since=***'))).toEqual([400, 'bad_request']);
		expect((await h.activity('token.regenerated')).map((e) => e.after.kind).sort()).toEqual(['browser', 'server']);
		// removing the product keeps the tokens; a re-add restores the same ones
		h.clock.advance(1000);
		await owner.del(`${site}/products/notes`);
		expect((await m.client.get(`${site}/tokens`)).json.items).toEqual([]);
		expect(codeOf(await m.client.post(`${site}/tokens/notes/reveal`))).toEqual([404, 'not_found']);
		h.clock.advance(1000);
		await owner.post(`${site}/products`, { productId: 'notes' });
		expect((await m.client.get(`${site}/tokens`)).json.items[0].browserToken).toBe(browser.json.token);
		// another product sees only its own revocations
		const chat = await h.connect({ ...notesManifest(), id: 'chat' });
		expect((await h.productCall(chat, 'GET', '/v1/product/revocations')).json.tokenIds).toEqual([]);
	});

	it('a server token sealed under another ENCRYPTION_KEY cannot be shown until it is regenerated', async () => {
		const { h, owner } = await setUp('tokens_key');
		await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}`;
		await owner.post(`${site}/products`, { productId: 'notes' });
		// the same database under another ENCRYPTION_KEY
		const other = await bootPortal({
			db: mongo.db('tokens_key'),
			env: { ENCRYPTION_KEY: 'another-encryption-key-0123456789abcdef' },
		});
		cleanups.push(other.close);
		const owner2 = await other.owner();
		expect((await owner2.get(`${site}/tokens`)).json.items[0].serverToken).toEqual({ canShow: false });
		const refused = await owner2.post(`${site}/tokens/notes/reveal`);
		expect(codeOf(refused)).toEqual([409, 'conflict']);
		expect(refused.json.detail).toBe('Cannot be shown: regenerate.');
		const regenerated = await owner2.post(`${site}/tokens/notes/regenerate`, { kind: 'server' });
		expect(typeof regenerated.json.token).toBe('string');
		expect((await owner2.get(`${site}/tokens`)).json.items[0].serverToken).toEqual({ canShow: true });
	});

	it('a change of ENCRYPTION_KEY keeps every stored secret: the previous key opens them, Re-seal moves them, then it can go (RT-14)', async () => {
		const { h, owner } = await setUp('tokens_rekey');
		await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const site = `/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}`;
		await owner.post(`${site}/products`, { productId: 'notes' });
		const token = (await owner.post(`${site}/tokens/notes/reveal`)).json.serverToken;
		expect(typeof token).toBe('string');
		const mail = { host: 'smtp.example.com', port: 587, user: 'mailer', password: 's3cret', senderAddress: 'no@example.com' };
		expect((await owner.put('/v1/admin/settings/mail', { mail })).status).toBe(200);
		// a two-step secret being set up (sealed too)
		expect((await owner.post('/v1/me/two-step/start')).status).toBe(200);
		// Re-seal is the Owner's
		const support = await h.admin('support');
		expect(codeOf(await support.client.post('/v1/admin/settings/reseal'))).toEqual([403, 'forbidden']);

		const NEW_KEY = 'new-encryption-key-0123456789abcdef-portal';
		const changing = await bootPortal({
			db: mongo.db('tokens_rekey'),
			env: { ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: 'test-encryption-key-0123456789abcdef-portal' },
		});
		cleanups.push(changing.close);
		const owner2 = await changing.owner();
		expect((await owner2.post(`${site}/tokens/notes/reveal`)).json.serverToken).toBe(token);
		expect((await owner2.get('/v1/admin/settings')).json.mail).toMatchObject({ hasPassword: true, passwordUnreadable: false });
		const first = await owner2.post('/v1/admin/settings/reseal');
		expect(first.status).toBe(200);
		expect(first.json).toEqual({
			keyId: expect.any(String),
			previousKeyId: expect.any(String),
			resealed: 5,
			current: 0,
			unreadable: 0,
			unreadableIn: {},
		});
		expect(ADMIN.encryption.result(first.json)).toBe(
			'5 re-sealed, 0 already on the current key, 0 could not be opened with either key. Every stored secret now uses the current key: ENCRYPTION_KEY_PREVIOUS can be removed.',
		);
		// the server token, the mail password, the two-step secret and both signing keys (K-21)
		expect((await owner2.post('/v1/admin/settings/reseal')).json).toMatchObject({ resealed: 0, current: 5, unreadable: 0 });
		expect((await changing.activity('settings.changed')).map((e) => e.target.id)).toContain('encryption_key');

		// the previous key removed: everything opens with the new key alone, nothing with the old one alone
		const db = mongo.db('tokens_rekey');
		const stored = /** @type {Record<string, any>} */ (await db.collection('identity_product_tokens').findOne({}));
		const aad = { websiteId: stored.websiteId, productId: 'notes', jti: stored.server.jti, purpose: 'server_token' };
		expect(createSecretBox({ encryptionKey: NEW_KEY }).openText(stored.server.sealed, { aad })).toBe(token);
		const settings = /** @type {Record<string, any>} */ (
			await db.collection('platform_system').findOne(/** @type {any} */ ({ _id: 'settings' }))
		);
		expect(createSystemStore(db, { encryptionKey: NEW_KEY }).passwordReadable(settings.mail.passSealed)).toBe(true);
		const old = await owner.post(`${site}/tokens/notes/reveal`);
		expect(codeOf(old)).toEqual([409, 'conflict']);

		// a wrong ENCRYPTION_KEY_PREVIOUS opens nothing: Re-seal names what to type or make again and never says the
		// previous key can be removed
		const wrong = await bootPortal({
			db: mongo.db('tokens_rekey'),
			env: {
				ENCRYPTION_KEY: 'third-encryption-key-0123456789abcdef-portal',
				ENCRYPTION_KEY_PREVIOUS: 'wrong-encryption-key-0123456789abcdef-portal',
			},
		});
		cleanups.push(wrong.close);
		// a new test client counts its idempotency keys from the start again: sign in with one this database has not seen
		const signIn = await wrong.api.call('POST', '/v1/auth/sign-in', {
			body: { email: 'owner@portal.test', password: PASSWORD },
			idempotencyKey: 'rekey-wrong-sign-in',
		});
		expect(signIn.status).toBe(200);
		const cookie = (signIn.cookies[0] ?? '').split(';')[0];
		const lost = await wrong.api.call('POST', '/v1/admin/settings/reseal', {
			body: {},
			cookie,
			idempotencyKey: 'rekey-wrong-reseal',
		});
		expect(lost.json).toMatchObject({
			resealed: 0,
			unreadable: 5,
			unreadableIn: { signingKeys: 2, mailPassword: 1, serverTokens: 1, twoStep: 1 },
		});
		const words = ADMIN.encryption.result(lost.json);
		expect(words).not.toContain('can be removed.');
		expect(words).toContain('Keep ENCRYPTION_KEY_PREVIOUS');
		expect(words).toContain('the email sending password: type it again under Email sending on this page');
		expect(words).toContain('1 server token: on the website’s Install and tokens page, press Regenerate');
		expect(words).toContain('1 two-step sign-in: an Owner turns that person’s two-step off');
		expect(words).toContain('Remove ENCRYPTION_KEY_PREVIOUS only when "could not be opened" is 0.');
	});
});
