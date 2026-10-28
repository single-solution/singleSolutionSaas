/**
 * Step 7 of the settings ownership design: when two products are on the same website the Portal provisions each link they
 * need, with the scopes the manifests allow, and nobody pastes a token. A link is revoked when a product leaves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { createKeyResolver, verifyToken } from '@ss/protocol';
import { closeMongoClients } from '../../../src/testing.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, PORTAL_URL, bootPortal, codeOf } from '../catalog/boot.js';
import { validateWebsiteConnections } from '@ss/contracts';

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

/** A product of the test: the Notes manifest under another id, with its links. @param {string} id @param {Record<string, unknown>} links */
const product = (id, links) => ({ ...notesManifest(), id, name: id[0]?.toUpperCase() + id.slice(1), links });

const offer = (/** @type {string} */ scope, name = scope) => ({ scope, name, description: `${name}.` });

const PAYMENTS = product('payments', {
	offers: [
		offer('methods.read', 'Read the payment methods'),
		offer('payments.create', 'Create payments'),
		offer('payments.read', 'Read payments'),
		offer('payments.refund', 'Refund payments'),
	],
});
// Ecommerce reads the methods always, and creates, reads and refunds payments while its `notes` feature is on; it also
// asks for a scope Payments does not offer
const ECOMMERCE = product('ecommerce', {
	needs: [
		{ product: 'payments', scopes: ['methods.read'], features: [] },
		{
			product: 'payments',
			scopes: ['payments.create', 'payments.read', 'payments.refund', 'payments.delete'],
			features: ['notes'],
		},
		{ product: 'notifications', scopes: ['messages.send'], features: ['inbox'] },
	],
});
const NOTIFICATIONS = product('notifications', {
	offers: [offer('messages.send', 'Send messages'), offer('events.forward', 'Forward events')],
});

/**
 * Ecommerce, Payments and Notifications connected; Ecommerce and Payments on the first website, Ecommerce alone on the
 * second.
 * @param {string} name
 */
const setUp = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	const rawOwner = await h.owner();
	const ecommerce = await h.connect(ECOMMERCE);
	const payments = await h.connect(PAYMENTS);
	const notifications = await h.connect(NOTIFICATIONS);
	const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
	const [w1 = '', w2 = ''] = m.websiteIds;

	/**
	 * @template {ReturnType<typeof h.api.session>} T
	 * @param {T} client
	 * @param {string} email
	 * @returns {T}
	 */
	const wrap = (client, email) => {
		const rawPut = client.put.bind(client);
		const rawPost = client.post.bind(client);
		client.put = async (path, body) => {
			if (
				body &&
				typeof body === 'object' &&
				/** @type {Record<string, unknown>} */ (body).password === PASSWORD &&
				!(/** @type {Record<string, unknown>} */ (body).code)
			) {
				const rest = Object.fromEntries(
					Object.entries(/** @type {Record<string, unknown>} */ (body)).filter(([k]) => k !== 'password'),
				);
				const otp = await h.confirmOtp(client, email);
				return rawPut(path, { ...rest, ...otp });
			}
			return rawPut(path, body);
		};
		client.post = async (path, body) => {
			if (
				body &&
				typeof body === 'object' &&
				/** @type {Record<string, unknown>} */ (body).password === PASSWORD &&
				!(/** @type {Record<string, unknown>} */ (body).code)
			) {
				const rest = Object.fromEntries(
					Object.entries(/** @type {Record<string, unknown>} */ (body)).filter(([k]) => k !== 'password'),
				);
				const otp = await h.confirmOtp(client, email);
				return rawPost(path, { ...rest, ...otp });
			}
			return rawPost(path, body);
		};
		return client;
	};
	const owner = wrap(rawOwner, 'owner@portal.test');
	wrap(m.client, m.email);
	const rawAdmin = h.admin.bind(h);
	h.admin = async (role) => {
		const res = await rawAdmin(role);
		wrap(res.client, res.email);
		return res;
	};
	const site = (/** @type {string} */ website = w1) => `/v1/merchants/${m.merchantId}/websites/${website}`;
	const add = async (/** @type {string} */ productId, website = w1) => {
		const res = await owner.post(`${site(website)}/products`, { productId });
		h.clock.advance(1000);
		return res;
	};
	const switchOn = async (/** @type {typeof ecommerce} */ p, /** @type {string[]} */ on, version = 1, website = w1) => {
		const admin = await h.api.call('GET', '/v1/me', { cookie: owner.cookie });
		const res = await h.productCall(p, 'PUT', `/v1/product/websites/${website}/features`, {
			version,
			on,
			adminId: admin.json.admin.adminId,
			adminName: 'Olivia',
		});
		h.clock.advance(1000);
		return res;
	};
	const fetchAs = (/** @type {typeof ecommerce} */ p, website = w1) =>
		h.productCall(p, 'GET', `/v1/product/websites/${website}/connections`);
	/** The link token of the caller, as the callee would check it. @param {string} token @param {string} callee @param {string} [caller] */
	const check = (token, callee, caller) =>
		verifyToken({
			token,
			keyResolver: createKeyResolver({ jwks: h.portal.shared.keys.publishedJwks() }),
			issuer: PORTAL_URL,
			productId: callee,
			kind: 'link',
			...(caller ? { caller } : {}),
			now: h.clock.now,
			isRevoked: async (jti) =>
				(
					await h.productCall(callee === 'payments' ? payments : notifications, 'GET', '/v1/product/revocations')
				).json.tokenIds.includes(jti),
		});
	return { h, owner, ecommerce, payments, notifications, m, w1, w2, site, add, switchOn, fetchAs, check };
};

const linksChanged = (/** @type {string} */ websiteId) => ({ type: 'website.settings_changed', websiteId, what: 'links' });

describe('links between products: provisioned by the Portal, nobody pastes anything', () => {
	it('adding Ecommerce and Payments to a website links them; only offered scopes of features that are on are granted', async () => {
		const { ecommerce, payments, w1, add, switchOn, fetchAs, check } = await setUp('links_add');
		await add('ecommerce');
		// alone: nothing to link
		expect((await fetchAs(ecommerce)).json.links).toEqual({ out: [], in: [] });
		await add('payments');
		// no feature of Ecommerce is on: only its always-needed scope is granted
		const out = (await fetchAs(ecommerce)).json;
		const inn = (await fetchAs(payments)).json;
		expect(validateWebsiteConnections(out).ok).toBe(true);
		expect(out.links.out).toEqual([{ to: 'payments', token: expect.any(String), scopes: ['methods.read'] }]);
		expect(out.links.in).toEqual([]);
		expect(inn.links).toEqual({ out: [], in: [{ from: 'ecommerce', scopes: ['methods.read'] }] });
		// the token proves who (Ecommerce calling Payments on this website) and carries no scope
		const claims = await check(out.links.out[0].token, 'payments', 'ecommerce');
		expect(claims).toMatchObject({
			kind: 'link',
			productId: 'payments',
			caller: 'ecommerce',
			websiteId: w1,
			domain: 'shop.example.com',
		});
		expect(Object.keys(claims).sort()).toEqual(['caller', 'domain', 'iat', 'iss', 'jti', 'kind', 'productId', 'websiteId']);
		// switching the feature on adds the scopes Payments offers; the one it does not offer is never granted
		await switchOn(ecommerce, ['notes']);
		const wider = (await fetchAs(payments)).json.links.in;
		expect(wider).toEqual([
			{ from: 'ecommerce', scopes: ['methods.read', 'payments.create', 'payments.read', 'payments.refund'] },
		]);
		// the same token still works (a changed grant needs no new token)
		expect((await fetchAs(ecommerce)).json.links.out[0].token).toBe(out.links.out[0].token);
		// switching it off narrows the grant again
		await switchOn(ecommerce, [], 2);
		expect((await fetchAs(payments)).json.links.in).toEqual([{ from: 'ecommerce', scopes: ['methods.read'] }]);
		// and a link nothing needs: Notifications is on the website but Ecommerce's `inbox` feature is off
		await add('notifications');
		expect((await fetchAs(ecommerce)).json.links.out.map((/** @type {any} */ l) => l.to)).toEqual(['payments']);
	});

	it('tells the products involved (and only them) when a link is created, changes or is revoked', async () => {
		const { h, ecommerce, payments, notifications, w1, add, switchOn } = await setUp('links_notices');
		await add('ecommerce');
		await add('notifications');
		for (const p of [ecommerce, payments, notifications]) p.notices.splice(0);
		await add('payments');
		expect(ecommerce.notices.filter((n) => n.type === 'website.settings_changed')).toEqual([linksChanged(w1)]);
		expect(payments.notices.filter((n) => n.type === 'website.settings_changed')).toEqual([linksChanged(w1)]);
		expect(notifications.notices.filter((n) => n.type === 'website.settings_changed')).toEqual([]);
		for (const p of [ecommerce, payments, notifications]) p.notices.splice(0);
		await switchOn(ecommerce, ['inbox', 'notes']);
		// Ecommerce and Notifications (a new link) and Payments (wider grant) are all told
		expect(
			ecommerce.notices.some((n) => n.type === 'website.settings_changed' && /** @type {any} */ (n).what === 'links'),
		).toBe(true);
		expect(
			notifications.notices.some((n) => n.type === 'website.settings_changed' && /** @type {any} */ (n).what === 'links'),
		).toBe(true);
		expect(payments.notices.some((n) => n.type === 'website.settings_changed' && /** @type {any} */ (n).what === 'links')).toBe(
			true,
		);
		h.clock.advance(1000);
	});

	it('works the links out again without rotating anything when nothing changed', async () => {
		const { h, ecommerce, w1, add, fetchAs, owner, site } = await setUp('links_again');
		await add('ecommerce');
		await add('payments');
		const before = (await fetchAs(ecommerce)).json;
		const version = (await h.productCall(ecommerce, 'GET', `/v1/product/websites/${w1}/status`)).json.connectionsVersion;
		expect(version).toBeGreaterThan(0);
		// reading, and a second add that fails, do not touch the link
		await owner.get(`${site()}/connections`);
		expect(codeOf(await add('payments'))).toEqual([409, 'conflict']);
		const again = (await fetchAs(ecommerce)).json;
		expect(again.links.out[0].token).toBe(before.links.out[0].token);
		expect((await h.productCall(ecommerce, 'GET', `/v1/product/websites/${w1}/status`)).json.connectionsVersion).toBe(version);
		expect((await h.activity('website.link_changed')).map((e) => e.after.change)).toEqual(['created']);
	});

	it('another website of the same merchant gets no link from this one', async () => {
		const { ecommerce, w2, add, fetchAs } = await setUp('links_sites');
		await add('ecommerce');
		await add('payments');
		await add('ecommerce', w2);
		expect((await fetchAs(ecommerce, w2)).json.links).toEqual({ out: [], in: [] });
	});

	it('is revoked at once when either product is removed from the website, and restored when it is added again', async () => {
		const { h, owner, ecommerce, payments, w1, site, add, fetchAs, check } = await setUp('links_remove');
		await add('ecommerce');
		await add('payments');
		const first = (await fetchAs(ecommerce)).json.links.out[0];
		expect((await check(first.token, 'payments', 'ecommerce')).caller).toBe('ecommerce');
		payments.notices.splice(0);
		// Payments leaves: the token is on the revocation list, no one is given it, Payments is told to read the list
		expect((await owner.del(`${site()}/products/payments`)).status).toBe(200);
		await expect(check(first.token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		expect(payments.notices.map((n) => n.type)).toContain('token.revoked');
		expect((await fetchAs(ecommerce)).json.links).toEqual({ out: [], in: [] });
		expect(await h.db.collection('website_links').countDocuments({})).toBe(0);
		// Payments comes back: a new link with a new token (the old one stays revoked)
		await add('payments');
		const second = (await fetchAs(ecommerce)).json.links.out[0];
		expect(second.token).not.toBe(first.token);
		expect((await check(second.token, 'payments', 'ecommerce')).websiteId).toBe(w1);
		await expect(check(first.token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		// the caller leaves: the same
		expect((await owner.del(`${site()}/products/ecommerce`)).status).toBe(200);
		await expect(check(second.token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		expect((await fetchAs(payments)).json.links).toEqual({ out: [], in: [] });
		expect((await h.activity('website.link_changed')).map((e) => e.after.change).sort()).toEqual([
			'created',
			'created',
			'revoked',
			'revoked',
		]);
	});

	it('a link token is for one website and one callee: it is not valid for another callee or as another caller', async () => {
		const { ecommerce, w1, add, fetchAs, check } = await setUp('links_stolen');
		await add('ecommerce');
		await add('payments');
		const { token } = (await fetchAs(ecommerce)).json.links.out[0];
		await expect(check(token, 'notifications')).rejects.toMatchObject({ code: 'invalid_token' });
		await expect(check(token, 'payments', 'chat')).rejects.toMatchObject({ code: 'invalid_token' });
		expect((await check(token, 'payments')).websiteId).toBe(w1);
	});

	it('a merchant switches a link off (the token is revoked), on again (a new token) or regenerates it, after confirming the password', async () => {
		const { h, ecommerce, payments, m, w1, site, add, fetchAs, check } = await setUp('links_switch');
		await add('ecommerce');
		await add('payments');
		const first = (await fetchAs(ecommerce)).json.links.out[0];
		const path = `${site()}/links/payments/ecommerce`;
		// the console shows the link in words, never the token
		let view = (await m.client.get(`${site()}/connections`)).json;
		expect(view.links).toEqual([
			{
				caller: 'ecommerce',
				callerName: 'Ecommerce',
				callee: 'payments',
				calleeName: 'Payments',
				state: 'on',
				scopes: [{ scope: 'methods.read', name: 'Read the payment methods', description: 'Read the payment methods.' }],
				delivered: true,
			},
		]);
		expect(JSON.stringify(view)).not.toContain(first.token);
		// the password is needed, whoever the session is
		for (const action of ['switch', 'regenerate']) {
			expect(codeOf(await m.client.post(`${path}/${action}`, action === 'switch' ? { on: false } : {}))[0]).toBe(422);
			expect(
				codeOf(
					await m.client.post(`${path}/${action}`, { ...(action === 'switch' ? { on: false } : {}), password: 'nope' }),
				)[0],
			).toBeGreaterThanOrEqual(400);
		}
		expect((await fetchAs(ecommerce)).json.links.out.length).toBe(1);
		// regenerate: the old token is revoked at once, a new one is given
		h.clock.advance(1000);
		expect((await m.client.post(`${path}/regenerate`, CONFIRM)).status).toBe(200);
		await expect(check(first.token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		const regenerated = (await fetchAs(ecommerce)).json.links.out[0];
		expect((await check(regenerated.token, 'payments', 'ecommerce')).caller).toBe('ecommerce');
		// off: nothing is given or granted, the token is revoked
		h.clock.advance(1000);
		view = (await m.client.post(`${path}/switch`, { on: false, ...CONFIRM })).json;
		expect(view.links[0].state).toBe('off');
		await expect(check(regenerated.token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		expect((await fetchAs(ecommerce)).json.links.out).toEqual([]);
		expect((await fetchAs(payments)).json.links.in).toEqual([]);
		expect(codeOf(await m.client.post(`${path}/regenerate`, CONFIRM))).toEqual([409, 'conflict']);
		// a recompute (here: another product arriving) does not turn it on again
		await add('notifications');
		expect((await fetchAs(ecommerce)).json.links.out).toEqual([]);
		// on again: a new token
		h.clock.advance(1000);
		view = (await m.client.post(`${path}/switch`, { on: true, ...CONFIRM })).json;
		expect(view.links[0].state).toBe('on');
		const back = (await fetchAs(ecommerce)).json.links.out[0];
		expect(back.token).not.toBe(regenerated.token);
		expect((await check(back.token, 'payments', 'ecommerce')).websiteId).toBe(w1);
		// all of it is logged, and none of it carries a token
		const changes = await h.activity('website.link_changed');
		expect(changes.map((e) => e.after.change)).toEqual(['switched_on', 'switched_off', 'regenerated', 'created']);
		expect(JSON.stringify(changes)).not.toContain(back.token);
		// bad requests
		expect(codeOf(await m.client.post(`${path}/switch`, { on: 'yes', ...CONFIRM }))[0]).toBe(422);
		expect(codeOf(await m.client.post(`${site()}/links/payments/chat/regenerate`, CONFIRM))[0]).toBe(404);
	});

	it('only the merchant of the website, the Owner and Support change a link; Finance, another merchant and a product do not', async () => {
		const { h, ecommerce, owner, m, site, add } = await setUp('links_rights');
		await add('ecommerce');
		await add('payments');
		const finance = await h.admin('finance');
		const support = await h.admin('support');
		const other = await h.merchant('other@shop.test', ['other.example.com']);
		const path = `${site()}/links/payments/ecommerce/switch`;
		const body = { on: false, ...CONFIRM };
		expect(codeOf(await finance.client.post(path, body))[0]).toBe(403);
		expect(codeOf(await other.client.post(path, body))[0]).toBeGreaterThanOrEqual(403);
		expect([401, 403]).toContain((await h.productCall(ecommerce, 'POST', path, body)).status);
		expect((await owner.get(`${site()}/connections`)).json.links[0].state).toBe('on');
		expect((await support.client.post(path, body)).status).toBe(200);
		expect((await m.client.post(path, { on: true, ...CONFIRM })).status).toBe(200);
		// the console has no way to write a scope or a token: those routes do not exist
		for (const route of [
			'links',
			'links/payments/ecommerce',
			'links/payments/ecommerce/token',
			'links/payments/ecommerce/scopes',
		])
			expect([404, 405]).toContain(
				(await m.client.put(`${site()}/${route}`, { scopes: ['payments.refund'], token: 'x', ...CONFIRM })).status,
			);
	});

	it('the links are stored sealed, and Re-seal covers them', async () => {
		const { h, ecommerce, add, fetchAs } = await setUp('links_seal');
		await add('ecommerce');
		await add('payments');
		const { token } = (await fetchAs(ecommerce)).json.links.out[0];
		const stored = JSON.stringify(await h.db.collection('website_links').find({}).toArray());
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(token.split('.')[1]);
		const resealed = await (await h.owner()).post('/v1/admin/settings/reseal');
		expect(resealed.json).toMatchObject({ unreadable: 0 });
		expect(resealed.json.resealed + resealed.json.current).toBeGreaterThanOrEqual(3);
	});

	it('forgetting a website revokes every link and deletes its connections (the safety net of a website removal)', async () => {
		const { h, ecommerce, m, w2, add, fetchAs, check } = await setUp('links_website');
		await add('ecommerce', w2);
		await add('payments', w2);
		const { token } = (await fetchAs(ecommerce, w2)).json.links.out[0];
		expect((await check(token, 'payments', 'ecommerce')).websiteId).toBe(w2);
		await /** @type {any} */ (h.portal.modules.service('website')).forgetWebsite({ merchantId: m.merchantId, websiteId: w2 });
		await expect(check(token, 'payments', 'ecommerce')).rejects.toMatchObject({ code: 'invalid_token' });
		expect(await h.db.collection('website_links').countDocuments({})).toBe(0);
	});
});
