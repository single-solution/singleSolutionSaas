import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

const DAY = 24 * 3600_000;

describe('websites', () => {
	it('adds by domain only, normalised, with a test twin sharing the domain', async () => {
		const h = await boot();
		const { client, merchantId } = await h.signupOwner('o@example.com');
		const created = await client.post(`/v1/merchants/${merchantId}/websites`, {
			domain: 'HTTPS://user@Shop.Example.COM:443/path?q#f',
		});
		expect(created.status).toBe(201);
		const { website, twin } = created.json;
		expect(website).toMatchObject({
			domain: 'shop.example.com',
			env: 'live',
			twinId: twin.websiteId,
			status: 'active',
			merchantId,
		});
		expect(twin).toMatchObject({ domain: 'shop.example.com', env: 'test', twinId: website.websiteId });
		expect(website.websiteId).not.toBe(twin.websiteId);
		const idn = await client.post(`/v1/merchants/${merchantId}/websites`, { domain: 'Bücher.example' });
		expect(idn.json.website.domain).toBe('xn--bcher-kva.example');

		for (const domain of ['127.0.0.1', 'localhost', 'intranet', '*.example.com', '[::1]', '', 42]) {
			const res = await client.post(`/v1/merchants/${merchantId}/websites`, { domain });
			expect(res.status, String(domain)).toBe(422);
		}
		expect((await client.post(`/v1/merchants/${merchantId}/websites`, { domain: 'a.example', extra: 1 })).status).toBe(422);

		const list = await client.get(`/v1/merchants/${merchantId}/websites`);
		expect(list.json.items).toHaveLength(4);
		expect(await h.service.listWebsites(merchantId)).toHaveLength(4);
		expect(await h.service.getWebsite(website.websiteId)).toMatchObject({
			websiteId: website.websiteId,
			merchantId,
			env: 'live',
		});
		expect(await h.service.websiteByDomain('SHOP.example.com.')).toMatchObject({ websiteId: website.websiteId });
		expect(await h.service.websiteByDomain('shop.example.com', { env: 'test' })).toMatchObject({ websiteId: twin.websiteId });
		expect(await h.service.websiteByDomain('not a domain')).toBeNull();
		expect(await h.service.websiteByDomain('nobody.example')).toBeNull();
		await expect(h.service.getWebsite('web_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found' });
		expect((await client.get(`/v1/merchants/${merchantId}/websites/${twin.websiteId}`)).json.env).toBe('test');
	});

	it('website settings: time zone, language, currency for the pair, validated, audited, documents re-signed (F.16)', async () => {
		const h = await boot();
		const owner = await h.signupOwner('settings@example.com');
		const root = await h.staffUser('root@example.com');
		const created = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'shop.example.com' });
		const { websiteId } = created.json.website;
		const twinId = created.json.twin.websiteId;
		expect(created.json.website).toMatchObject({ timeZone: null, language: null, currency: null });
		const path = `/v1/merchants/${owner.merchantId}/websites/${websiteId}`;
		const bad = await owner.client.send('PATCH', path, { timeZone: 'Mars/Base', language: '??', currency: 'EURO' });
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path).sort()).toEqual(['/currency', '/language', '/timeZone']);
		expect((await owner.client.send('PATCH', path, {})).status).toBe(422);
		const saved = await owner.client.send('PATCH', path, { timeZone: 'europe/berlin', language: 'de-de', currency: 'eur' });
		expect(saved.status).toBe(200);
		expect(saved.json).toMatchObject({ timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.getWebsite(twinId)).toMatchObject({ timeZone: 'Europe/Berlin', currency: 'EUR' });
		expect(h.commerce.invalidated).toEqual(expect.arrayContaining([websiteId, twinId]));
		// staff (Admin Console) may change them too; null clears one
		const cleared = await root.client.send('PATCH', path, { currency: null });
		expect(cleared.json).toMatchObject({ timeZone: 'Europe/Berlin', currency: null });
		const audit = await h.db.collection('platform_audit').find({ action: 'website.settings_updated' }).toArray();
		expect(audit).toHaveLength(2);
		expect(audit[1]).toMatchObject({ before: { currency: 'EUR' }, actor: { type: 'staff' } });
	});

	it('refuses public suffixes when a predicate is configured', async () => {
		const h = await boot({ identity: { isPublicSuffix: (/** @type {string} */ d) => d === 'co.uk' } });
		const { client, merchantId } = await h.signupOwner('o@example.com');
		expect((await client.post(`/v1/merchants/${merchantId}/websites`, { domain: 'co.uk' })).status).toBe(422);
		expect((await client.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.co.uk' })).status).toBe(201);
	});

	it('keeps domains globally unique, also under concurrent claims', async () => {
		const h = await boot();
		const owners = [];
		for (let i = 0; i < 6; i += 1) owners.push(await h.signupOwner(`o${i}@example.com`));
		const actor = (/** @type {any} */ o) => ({
			type: /** @type {const} */ ('merchant_user'),
			id: o.userId,
			merchantId: o.merchantId,
		});
		const results = await Promise.allSettled(
			owners.map((o) => h.service.createWebsite({ merchantId: o.merchantId, domain: 'race.example.com', actor: actor(o) })),
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const rejected = /** @type {PromiseRejectedResult[]} */ (results.filter((r) => r.status === 'rejected'));
		expect(rejected.map((r) => r.reason.code)).toEqual(Array(5).fill('domain_taken'));

		// the same merchant twice, concurrently
		const first = /** @type {(typeof owners)[number]} */ (owners[0]);
		const same = await Promise.allSettled(
			[1, 2, 3].map(() =>
				h.service.createWebsite({ merchantId: first.merchantId, domain: 'twice.example.com', actor: actor(first) }),
			),
		);
		expect(same.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const actives = (await Promise.all(owners.map((o) => h.service.listWebsites(o.merchantId)))).flat();
		expect(actives.filter((w) => w.domain === 'race.example.com')).toHaveLength(2); // live + test of the winner
		expect(actives.filter((w) => w.domain === 'twice.example.com')).toHaveLength(2);

		const winner = owners.find((_, i) => results[i]?.status === 'fulfilled');
		const loser = owners.find((o) => o !== winner);
		const conflict = await /** @type {any} */ (loser).client.post(`/v1/merchants/${loser?.merchantId}/websites`, {
			domain: 'Race.Example.com',
		});
		expect([conflict.status, conflict.json.type]).toEqual([409, 'https://portal.test/problems/domain_taken']);
	});

	it('deletes softly: keys revoked, grants dropped, domain cooled down for 30 days', async () => {
		const h = await boot();
		const a = await h.signupOwner('a@example.com');
		const b = await h.signupOwner('b@example.com');
		const site = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'cool.example.com' });
		const { websiteId } = site.json.website;
		const twinId = site.json.twin.websiteId;
		const key = await a.client.post(`/v1/merchants/${a.merchantId}/websites/${twinId}/keys`, {
			kind: 'sk',
			scopes: ['events.write'],
		});
		await a.client.post(`/v1/merchants/${a.merchantId}/team/invites`, {
			email: 'g@example.com',
			grants: [{ websiteId, roles: ['editor'] }],
		});
		const g = h.client();
		await g.post('/v1/auth/invites/accept', { token: h.mailer.token('g@example.com', 'invite'), password: 'a good password' });

		const deleted = await a.client.del(`/v1/merchants/${a.merchantId}/websites/${twinId}`); // either id deletes the pair
		expect(deleted.status).toBe(200);
		expect(deleted.json.websiteIds.sort()).toEqual([websiteId, twinId].sort());
		expect(Date.parse(deleted.json.domainReleaseAt)).toBe(h.clock.now() + 30 * DAY);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites`)).json.items).toEqual([]);
		expect((await a.client.del(`/v1/merchants/${a.merchantId}/websites/${websiteId}`)).status).toBe(404);
		expect((await h.service.getWebsite(websiteId)).status).toBe('deleted');
		const keys = await a.client.get(`/v1/merchants/${a.merchantId}/websites/${twinId}/keys`);
		expect(keys.json.items[0]).toMatchObject({ keyId: key.json.keyId, status: 'revoked', revokeReason: 'website_deleted' });
		expect(h.integration.events.at(-1)).toMatchObject({ type: 'key.revoked@1', data: { keyIds: [key.json.keyId] } });
		const team = await a.client.get(`/v1/merchants/${a.merchantId}/team`);
		expect(team.json.members.find((/** @type {any} */ m) => m.email === 'g@example.com').grants).toEqual([]);
		expect(
			(
				await a.client.post(`/v1/merchants/${a.merchantId}/websites/${websiteId}/keys`, {
					kind: 'pk',
					scopes: ['elements.read'],
				})
			).status,
		).toBe(404);

		// cooldown: another merchant waits, the same merchant may re-add at once
		expect((await b.client.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'cool.example.com' })).status).toBe(409);
		const readd = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'cool.example.com' });
		expect(readd.status).toBe(201);
		expect(readd.json.website.websiteId).not.toBe(websiteId);
		await a.client.del(`/v1/merchants/${a.merchantId}/websites/${readd.json.website.websiteId}`);
		h.clock.advance(30 * DAY - 1000);
		const b2 = await h.login('b@example.com');
		const a2 = await h.login('a@example.com');
		expect((await b2.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'cool.example.com' })).status).toBe(409);
		h.clock.advance(2000);
		expect((await b2.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'cool.example.com' })).status).toBe(201);
		expect((await a2.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'cool.example.com' })).status).toBe(409);
		const audit = await h.portal.shared.audit.list({ merchantId: a.merchantId });
		expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['website.deleted', 'key.revoked_bulk']));
	});

	it('staff transfer websites between merchants (audited, keys revoked, grants dropped)', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const a = await h.signupOwner('a@example.com');
		const b = await h.signupOwner('b@example.com');
		const site = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'moving.example.com' });
		const { websiteId } = site.json.website;
		const key = await a.client.post(`/v1/merchants/${a.merchantId}/websites/${websiteId}/keys`, {
			kind: 'pk',
			scopes: ['events.write'],
		});
		await a.client.post(`/v1/merchants/${a.merchantId}/team/invites`, {
			email: 'g@example.com',
			grants: [{ websiteId, roles: ['editor'] }],
		});
		await h.call('POST', '/v1/auth/invites/accept', {
			body: { token: h.mailer.token('g@example.com', 'invite'), password: 'a good password' },
		});

		const path = `/v1/admin/websites/${websiteId}/transfer`;
		expect((await a.client.post(path, { toMerchantId: b.merchantId, reason: 'x' })).status).toBe(401);
		expect((await root.client.post(path, { toMerchantId: b.merchantId })).status).toBe(422);
		expect((await root.client.post(path, { toMerchantId: a.merchantId, reason: 'same' })).status).toBe(409);
		expect((await root.client.post(path, { toMerchantId: 'mer_00000000000000000000000000', reason: 'ghost' })).status).toBe(
			404,
		);
		const moved = await root.client.post(path, { toMerchantId: b.merchantId, reason: 'domain ownership proven by B' });
		expect(moved.status).toBe(200);
		expect(moved.json).toMatchObject({ websiteId, merchantId: b.merchantId, domain: 'moving.example.com' });
		expect((await h.service.getWebsite(site.json.twin.websiteId)).merchantId).toBe(b.merchantId);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites`)).json.items).toEqual([]);
		expect((await b.client.get(`/v1/merchants/${b.merchantId}/websites`)).json.items).toHaveLength(2);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites/${websiteId}`)).status).toBe(404);
		expect(
			await h.service.isKeyRevoked(
				/** @type {any} */ ({ keyId: key.json.keyId, websiteId, merchantId: a.merchantId, kind: 'pk', env: 'live' }),
			),
		).toBe(true);
		const team = await a.client.get(`/v1/merchants/${a.merchantId}/team`);
		expect(team.json.members.find((/** @type {any} */ m) => m.email === 'g@example.com').grants).toEqual([]);
		const fresh = await b.client.post(`/v1/merchants/${b.merchantId}/websites/${websiteId}/keys`, {
			kind: 'pk',
			scopes: ['elements.read'],
		});
		expect(fresh.status).toBe(201);
		for (const merchantId of [a.merchantId, b.merchantId]) {
			const entries = await h.portal.shared.audit.list({ merchantId, targetId: websiteId });
			expect(entries.find((e) => e.action === 'website.transferred')).toMatchObject({
				action: 'website.transferred',
				reason: 'domain ownership proven by B',
				actor: { type: 'staff' },
			});
		}
		await b.client.del(`/v1/merchants/${b.merchantId}/websites/${websiteId}`);
		expect((await root.client.post(path, { toMerchantId: a.merchantId, reason: 'back' })).status).toBe(409);

		// lookup by domain for staff
		const found = await root.client.get('/v1/admin/websites?domain=MOVING.example.com');
		expect(found.json.items).toEqual([]);
		await b.client.post(`/v1/merchants/${b.merchantId}/websites`, { domain: 'moving.example.com' });
		expect((await root.client.get('/v1/admin/websites?domain=moving.example.com&env=test')).json.items[0]).toMatchObject({
			env: 'test',
		});
	});

	it('rolls a failed website transfer back completely', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const a = await h.signupOwner('a@example.com');
		const b = await h.signupOwner('b@example.com');
		const site = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'stuck.example.com' });
		const { websiteId } = site.json.website;
		const twinId = site.json.twin.websiteId;
		// the domain claim update (the third write inside the transaction) fails: a validator refuses B as owner
		await h.db.command({
			collMod: 'identity_domains',
			validator: { merchantId: { $ne: b.merchantId } },
			validationAction: 'error',
		});
		const failed = await root.client.post(`/v1/admin/websites/${websiteId}/transfer`, {
			toMerchantId: b.merchantId,
			reason: 'should not happen',
		});
		expect(failed.status).toBe(500);
		await h.db.command({ collMod: 'identity_domains', validator: {} });
		// nothing moved: both websites, the domain claim and the listings are exactly where they were
		expect((await h.service.getWebsite(websiteId)).merchantId).toBe(a.merchantId);
		expect((await h.service.getWebsite(twinId)).merchantId).toBe(a.merchantId);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}/websites`)).json.items).toHaveLength(2);
		expect((await b.client.get(`/v1/merchants/${b.merchantId}/websites`)).json.items).toEqual([]);
		expect(await h.db.collection('identity_domains').findOne({ _id: /** @type {any} */ ('stuck.example.com') })).toMatchObject({
			merchantId: a.merchantId,
		});
		expect(await h.db.collection('identity_websites').countDocuments({ _id: { $in: [websiteId, twinId] } })).toBe(2);
		const entries = await h.portal.shared.audit.list({ merchantId: a.merchantId, targetId: websiteId });
		expect(entries.find((e) => e.action === 'website.transferred')).toBeUndefined();
		// the transfer succeeds once the cause is gone
		const moved = await root.client.post(`/v1/admin/websites/${websiteId}/transfer`, {
			toMerchantId: b.merchantId,
			reason: 'retry',
		});
		expect(moved.status).toBe(200);
		expect((await h.service.getWebsite(twinId)).merchantId).toBe(b.merchantId);
	});
});

describe('merchants (staff)', () => {
	it('suspends and resumes with a reason, notifies commerce, blocks writes while suspended', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const a = await h.signupOwner('a@example.com', { merchantName: 'Acme' });
		const site = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'acme.example.com' });
		const base = `/v1/admin/merchants/${a.merchantId}`;
		expect((await root.client.post(`${base}/suspend`, {})).status).toBe(422);
		expect((await a.client.post(`${base}/suspend`, { reason: 'x' })).status).toBe(401);
		const suspended = await root.client.post(`${base}/suspend`, { reason: 'chargeback fraud' });
		expect(suspended.json).toMatchObject({ status: 'suspended', suspension: { reason: 'chargeback fraud', by: root.staffId } });
		expect(h.commerce.calls).toEqual([{ merchantId: a.merchantId, status: 'suspended' }]);
		expect((await root.client.post(`${base}/suspend`, { reason: 'again' })).json.status).toBe('suspended');
		expect(h.commerce.calls).toHaveLength(1); // idempotent

		const blocked = await a.client.post(`/v1/merchants/${a.merchantId}/websites`, { domain: 'other.example.com' });
		expect([blocked.status, blocked.json.type]).toEqual([409, 'https://portal.test/problems/merchant_suspended']);
		expect(
			(
				await a.client.post(`/v1/merchants/${a.merchantId}/websites/${site.json.website.websiteId}/keys`, {
					kind: 'pk',
					scopes: ['elements.read'],
				})
			).status,
		).toBe(409);
		expect(
			(await a.client.post(`/v1/merchants/${a.merchantId}/team/invites`, { email: 'x@example.com', roles: ['editor'] }))
				.status,
		).toBe(409);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}`)).json.status).toBe('suspended'); // reads still work

		const resumed = await root.client.post(`${base}/resume`, { reason: 'resolved' });
		expect(resumed.json).toMatchObject({ status: 'active', suspension: null });
		expect(h.commerce.calls.at(-1)).toEqual({ merchantId: a.merchantId, status: 'active' });
		expect(await h.service.getMerchant(a.merchantId)).toMatchObject({
			merchantId: a.merchantId,
			name: 'Acme',
			status: 'active',
		});
		const audit = await h.portal.shared.audit.list({ merchantId: a.merchantId, targetId: a.merchantId });
		expect(audit.map((e) => [e.action, e.reason])).toEqual(
			expect.arrayContaining([
				['merchant.resumed', 'resolved'],
				['merchant.suspended', 'chargeback fraud'],
			]),
		);

		// staff merchant views and listing
		const detail = await root.client.get(base);
		expect(detail.json.websites).toHaveLength(2);
		await h.signupOwner('b@example.com');
		await h.signupOwner('c@example.com');
		const page1 = await root.client.get('/v1/admin/merchants?limit=2');
		expect(page1.json.items).toHaveLength(2);
		expect(page1.json.hasMore).toBe(true);
		const page2 = await root.client.get(`/v1/admin/merchants?limit=2&cursor=${page1.json.nextCursor}`);
		expect(page2.json.items).toHaveLength(1);
		await root.client.post(`${base}/suspend`, { reason: 'test filter' });
		expect(
			(await root.client.get('/v1/admin/merchants?status=suspended')).json.items.map((/** @type {any} */ m) => m.merchantId),
		).toEqual([a.merchantId]);
		expect((await root.client.get(`/v1/admin/merchants/mer_00000000000000000000000000`)).status).toBe(404);
		await expect(h.service.suspendMerchant({ merchantId: a.merchantId, reason: ' ' })).rejects.toMatchObject({
			code: 'validation_failed',
		});
		expect((await h.service.resumeMerchant({ merchantId: a.merchantId, reason: 'system' })).status).toBe('active');
	});

	it('survives a failing or absent commerce module', async () => {
		const h = await boot({ commerce: { fail: true } });
		const a = await h.signupOwner('a@example.com');
		expect((await h.service.suspendMerchant({ merchantId: a.merchantId, reason: 'r' })).status).toBe('suspended');
		expect(h.entries.some((e) => e.msg === 'commerce.onMerchantStatus failed')).toBe(true);
		const solo = await boot({ withCommerce: false });
		const b = await solo.signupOwner('b@example.com');
		expect((await solo.service.suspendMerchant({ merchantId: b.merchantId, reason: 'r' })).status).toBe('suspended');
	});

	it('teams: invites, member updates, owner protection, ownership transfer', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const { client: owner, merchantId, userId: ownerId, password } = await h.signupOwner('owner@example.com');
		const site = await owner.post(`/v1/merchants/${merchantId}/websites`, { domain: 't.example.com' });
		const invites = `/v1/merchants/${merchantId}/team/invites`;
		expect((await owner.post(invites, { email: 'x@example.com' })).status).toBe(422); // nothing granted
		expect((await owner.post(invites, { email: 'x@example.com', roles: ['owner'] })).status).toBe(422);
		expect(
			(
				await owner.post(invites, {
					email: 'x@example.com',
					grants: [{ websiteId: site.json.twin.websiteId, roles: ['editor'] }],
				})
			).status,
		).toBe(422); // live ids only
		expect((await owner.post(invites, { email: 'owner@example.com', roles: ['admin'] })).status).toBe(409);
		const first = await owner.post(invites, { email: 'x@example.com', roles: ['editor'] });
		const replaced = await owner.post(invites, { email: 'x@example.com', roles: ['billing'] });
		const team = await owner.get(`/v1/merchants/${merchantId}/team`);
		expect(team.json.invites.map((/** @type {any} */ i) => [i.inviteId, i.roles])).toEqual([
			[replaced.json.inviteId, ['billing']],
		]);
		expect((await owner.del(`${invites}/${first.json.inviteId}`)).status).toBe(404);
		expect((await owner.del(`${invites}/${replaced.json.inviteId}`)).status).toBe(204);
		expect(
			(
				await h.call('POST', '/v1/auth/invites/accept', {
					body: { token: h.mailer.token('x@example.com', 'invite'), password: 'a good password' },
				})
			).status,
		).toBe(400);
		h.mailer.setAvailable(false);
		expect((await owner.post(invites, { email: 'y@example.com', roles: ['admin'] })).status).toBe(503);
		h.mailer.setAvailable(true);

		await owner.post(invites, { email: 'y@example.com', roles: ['admin'] });
		const y = h.client();
		const accepted = await y.post('/v1/auth/invites/accept', {
			token: h.mailer.token('y@example.com', 'invite'),
			password: 'a good password',
		});
		const yId = accepted.json.user.userId;
		// expired invites
		await owner.post(invites, { email: 'z@example.com', roles: ['admin'] });
		h.clock.advance(8 * DAY);
		expect(
			(
				await h.call('POST', '/v1/auth/invites/accept', {
					body: { token: h.mailer.token('z@example.com', 'invite'), password: 'a good password' },
				})
			).status,
		).toBe(400);
		owner.setCookie((await h.login('owner@example.com')).cookie);
		y.setCookie((await h.login('y@example.com', 'a good password')).cookie);
		root.client.setCookie('');

		const members = `/v1/merchants/${merchantId}/team/members`;
		expect((await y.patch(`${members}/${ownerId}`, { roles: ['editor'] })).status).toBe(409); // owner protected
		expect((await y.del(`${members}/${ownerId}`)).status).toBe(409);
		expect((await owner.patch(`${members}/${yId}`, { roles: [], grants: [] })).status).toBe(422);
		expect(
			(
				await owner.patch(`${members}/${yId}`, {
					grants: [{ websiteId: 'web_00000000000000000000000000', roles: ['editor'] }],
				})
			).status,
		).toBe(422);
		expect((await owner.patch(`${members}/usr_00000000000000000000000000`, { roles: ['admin'] })).status).toBe(404);
		expect((await owner.patch(`${members}/${yId}`, { roles: ['owner'] })).status).toBe(422);

		// ownership transfer: owner only, with password
		const transfer = `/v1/merchants/${merchantId}/owner/transfer`;
		expect((await y.post(transfer, { userId: yId })).status).toBe(403); // admin lacks merchant.owner.transfer
		expect((await owner.post(transfer, { userId: yId, password: 'wrong password' })).status).toBe(401);
		expect((await owner.post(transfer, { userId: 'usr_00000000000000000000000000', password })).status).toBe(404);
		expect((await owner.post(transfer, { userId: ownerId, password })).status).toBe(409);
		const done = await owner.post(transfer, { userId: yId, password });
		expect(done.json.ownerUserId).toBe(yId);
		const after = await y.get(`/v1/merchants/${merchantId}/team`);
		expect(after.json.members.map((/** @type {any} */ m) => [m.userId, m.roles])).toEqual(
			expect.arrayContaining([
				[ownerId, ['admin']],
				[yId, ['owner']],
			]),
		);
		expect((await owner.post(transfer, { userId: ownerId, password })).status).toBe(403); // no longer owner
		// staff may transfer without a password
		const staff = await h.client();
		await staff.post('/v1/auth/staff/login', { email: 'root@example.com', password: root.password });
		h.clock.advance(30_000);
		await staff.post('/v1/auth/staff/mfa/verify', { code: h.code(root.secret) });
		const back = await staff.post(transfer, { userId: ownerId });
		expect(back.json.ownerUserId).toBe(ownerId);
		// rename (staff and owner)
		expect((await owner.patch(`/v1/merchants/${merchantId}`, { name: '  New name ' })).json.name).toBe('New name');
		expect((await staff.patch(`/v1/merchants/${merchantId}`, { name: 'Staff name' })).status).toBe(200);
		expect((await owner.patch(`/v1/merchants/${merchantId}`, { name: 'bad\u0001' })).status).toBe(422);
	});

	it('partners and developers: records and grants', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const a = await h.signupOwner('a@example.com');
		const partner = await root.client.post('/v1/admin/partners', { name: 'Agency', email: 'Agency@Example.com' });
		expect(partner.json).toMatchObject({ name: 'Agency', email: 'agency@example.com', status: 'active', grants: [] });
		const { partnerId } = partner.json;
		expect((await root.client.post('/v1/admin/partners', { name: 'Dup', email: 'agency@example.com' })).status).toBe(409);
		expect(
			(await root.client.post(`/v1/admin/partners/${partnerId}/grants`, { merchantId: 'mer_00000000000000000000000000' }))
				.status,
		).toBe(404);
		const granted = await root.client.post(`/v1/admin/partners/${partnerId}/grants`, { merchantId: a.merchantId });
		expect(granted.json.grants).toMatchObject([{ merchantId: a.merchantId, roles: ['admin'] }]);
		const regranted = await root.client.post(`/v1/admin/partners/${partnerId}/grants`, {
			merchantId: a.merchantId,
			roles: ['billing'],
		});
		expect(regranted.json.grants).toMatchObject([{ merchantId: a.merchantId, roles: ['billing'] }]);
		expect(await h.service.getPartner(partnerId)).toMatchObject({ partnerId, grants: [{ merchantId: a.merchantId }] });
		expect((await root.client.get('/v1/admin/partners')).json.items).toHaveLength(1);
		expect((await root.client.del(`/v1/admin/partners/${partnerId}/grants/${a.merchantId}`)).status).toBe(204);
		expect((await root.client.del(`/v1/admin/partners/${partnerId}/grants/${a.merchantId}`)).status).toBe(404);
		expect(
			(await root.client.post('/v1/admin/partners/prt_00000000000000000000000000/grants', { merchantId: a.merchantId }))
				.status,
		).toBe(404);

		const dev = await root.client.post('/v1/admin/developers', { name: 'Builder', email: 'dev@example.com' });
		const { developerId } = dev.json;
		expect((await root.client.post(`/v1/admin/developers/${developerId}/grants`, { appId: 'Bad App' })).status).toBe(422);
		expect(
			(await root.client.post(`/v1/admin/developers/${developerId}/grants`, { appId: 'app_notes' })).json.grants,
		).toMatchObject([{ appId: 'app_notes' }]);
		expect(await h.service.getDeveloper(developerId)).toMatchObject({ developerId, grants: [{ appId: 'app_notes' }] });
		expect((await root.client.get('/v1/admin/developers')).json.items).toHaveLength(1);
		expect((await root.client.del(`/v1/admin/developers/${developerId}/grants/app_notes`)).status).toBe(204);
		await expect(h.service.getDeveloper('dev_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found' });
		expect(await h.service.getStaff(root.staffId)).toMatchObject({ staffId: root.staffId, roles: ['superadmin'] });
		const audit = await h.portal.shared.audit.list({ targetId: partnerId });
		expect(audit.map((e) => e.action).sort()).toEqual([
			'partner.created',
			'partner.grant_revoked',
			'partner.granted',
			'partner.granted',
		]);
	});
});
