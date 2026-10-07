import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import { PASSWORD, bootPortal } from './boot.js';

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

/** @param {string} name */
const setUp = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	const owner = await h.owner();
	const notes = await h.connect(notesManifest());
	const chat = await h.connect({ ...notesManifest(), id: 'chat', name: 'Chat' });
	return { h, owner, notes, chat };
};

// The Portal clock moves a second after each action: a product refuses an identical notice signed in the same second as a
// replay (it is then kept and retried), so the tests keep notices apart.

/** @param {string} websiteId */
const changed = (websiteId) => ({ type: 'status.changed', websiteId });

describe('notices (PLAN 0.4.12)', () => {
	it('status.changed for add, remove, suspend, resume and credits that restart; signed with the Portal key', async () => {
		const { h, owner, notes, chat } = await setUp('notices_status');
		const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
		const [w1 = '', w2 = ''] = m.websiteIds;
		const base = `/v1/merchants/${m.merchantId}/websites`;
		await owner.post(`${base}/${w1}/products`, { productId: 'notes' });
		h.clock.advance(1000);
		await owner.post(`${base}/${w2}/products`, { productId: 'notes' });
		h.clock.advance(1000);
		await owner.post(`${base}/${w1}/products`, { productId: 'chat' });
		h.clock.advance(1000);
		expect(notes.notices).toEqual([changed(w1), changed(w2)]);
		expect(chat.notices).toEqual([changed(w1)]);
		await owner.del(`${base}/${w2}/products/notes`);
		h.clock.advance(1000);
		expect(notes.notices.at(-1)).toEqual(changed(w2));
		// suspend: the products on the merchant's websites (not removed) and every product's sessions of the merchant
		notes.notices.splice(0);
		chat.notices.splice(0);
		await owner.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'unpaid' });
		h.clock.advance(1000);
		expect(notes.notices).toEqual(expect.arrayContaining([changed(w1), { type: 'sessions.revoked', subject: m.merchantId }]));
		expect(notes.notices).not.toContainEqual(changed(w2));
		expect(chat.notices).toEqual(expect.arrayContaining([changed(w1), { type: 'sessions.revoked', subject: m.merchantId }]));
		notes.notices.splice(0);
		await owner.post(`/v1/admin/merchants/${m.merchantId}/resume`, {});
		h.clock.advance(1000);
		expect(notes.notices).toEqual([changed(w1)]);
		// grace, found by a status fetch, then a receipt that restarts
		await h.productCall(notes, 'PUT', '/v1/product/prices', {
			version: 2,
			features: [
				{ key: 'notes', name: 'Notes', description: 'N.', dependsOn: [], millicreditsPerHour: 1000 },
				{ key: 'inbox', name: 'Inbox', description: 'I.', dependsOn: ['notes'], millicreditsPerHour: 0 },
			],
		});
		const admin = await h.api.call('GET', '/v1/me', { cookie: owner.cookie });
		h.clock.advance(1000);
		await h.productCall(notes, 'PUT', `/v1/product/websites/${w1}/features`, {
			version: 1,
			on: ['notes'],
			adminId: admin.json.admin.adminId,
			adminName: 'Olivia',
		});
		notes.notices.splice(0);
		const grace = await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/status`);
		h.clock.advance(1000);
		expect(grace.json.status).toBe('grace');
		expect(notes.notices).toEqual([changed(w1)]);
		const receipt = await owner.post(`/v1/admin/merchants/${m.merchantId}/receipts`, {
			credits: 100,
			amountPaid: 'PKR 1',
			method: 'Cash',
		});
		expect(receipt.status).toBe(201);
		expect(notes.notices).toEqual([changed(w1), changed(w1)]);
	});

	it('a product that does not answer 2xx keeps its notices; they are retried oldest first after its next call', async () => {
		const { h, owner, notes } = await setUp('notices_retry');
		const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
		const [w1 = '', w2 = ''] = m.websiteIds;
		notes.tamper.noticeStatus = 503;
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId: 'notes' });
		h.clock.advance(1000);
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${w2}/products`, { productId: 'notes' });
		h.clock.advance(1000);
		await owner.del(`/v1/merchants/${m.merchantId}/websites/${w2}/products/notes`); // the same notice is not queued twice
		const catalog = /** @type {any} */ (h.portal.modules.service('catalog'));
		expect(await catalog.waitingNotices('notes')).toBe(2);
		expect(h.entries.some((e) => e.msg === 'notice not delivered')).toBe(true);
		const stored = await h.db.collection('catalog_notices').find({}).sort({ queuedAt: 1 }).toArray();
		expect(stored.map((n) => [n.type, n.attempts > 0])).toEqual([
			['status.changed', true],
			['status.changed', false],
		]);
		// still down: the next call tries again and keeps them
		await h.productCall(notes, 'GET', '/v1/product/directory/notes');
		h.clock.advance(1000);
		expect(await catalog.waitingNotices('notes')).toBe(2);
		// back up: the next call of that product delivers them, oldest first, and drops them
		delete notes.tamper.noticeStatus;
		h.clock.advance(1000);
		await h.productCall(notes, 'GET', '/v1/product/directory/notes');
		h.clock.advance(1000);
		expect(notes.notices).toEqual([changed(w1), changed(w2)]);
		expect(await catalog.waitingNotices('notes')).toBe(0);
		expect(await catalog.deliverNotices('notes')).toEqual({ delivered: 0, waiting: 0 });
		// a product that cannot be reached at all keeps them too
		await notes.close();
		await owner.del(`/v1/merchants/${m.merchantId}/websites/${w1}/products/notes`);
		h.clock.advance(1000);
		expect(await catalog.waitingNotices('notes')).toBe(1);
	});

	it('sessions.revoked to every connected product: merchant deleted, admin removed or role changed, password changed or reset, signed out', async () => {
		const { h, owner, notes, chat } = await setUp('notices_sessions');
		/** @param {string} subject */
		const revoked = (subject) => ({ type: 'sessions.revoked', subject });
		const support = await h.admin('support');
		const finance = await h.admin('finance');
		await owner.patch(`/v1/admin/admins/${support.adminId}`, { role: 'finance' });
		h.clock.advance(1000);
		expect(notes.notices).toContainEqual(revoked(support.adminId));
		expect(chat.notices).toContainEqual(revoked(support.adminId));
		await owner.del(`/v1/admin/admins/${finance.adminId}`);
		h.clock.advance(1000);
		expect(notes.notices).toContainEqual(revoked(finance.adminId));
		const m = await h.merchant('m@shop.test');
		await m.client.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'another long password' });
		h.clock.advance(1000);
		expect(notes.notices.filter((n) => n.subject === m.merchantId)).toHaveLength(1);
		await m.client.post('/v1/auth/sign-out');
		h.clock.advance(1000);
		expect(notes.notices.filter((n) => n.subject === m.merchantId)).toHaveLength(2);
		await h.api.call('POST', '/v1/auth/forgot-password', { body: { email: 'm@shop.test' } });
		h.clock.advance(1000);
		await h.api.call('POST', '/v1/auth/reset-password', {
			body: { token: h.mailer.token('m@shop.test', 'password_reset'), password: 'a third long password' },
		});
		h.clock.advance(1000);
		expect(notes.notices.filter((n) => n.subject === m.merchantId)).toHaveLength(3);
		const deleted = await owner.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: m.name });
		expect(deleted.status).toBe(204);
		h.clock.advance(1000);
		expect(notes.notices.filter((n) => n.subject === m.merchantId)).toHaveLength(4);
		expect(chat.notices.filter((n) => n.subject === m.merchantId)).toHaveLength(4);
	});

	it('website.deleted to every product the website ever had, once its products are removed', async () => {
		const { h, owner, notes, chat } = await setUp('notices_website');
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		const [w1 = ''] = m.websiteIds;
		const site = `/v1/merchants/${m.merchantId}/websites/${w1}`;
		await owner.post(`${site}/products`, { productId: 'notes' });
		h.clock.advance(1000);
		await owner.post(`${site}/products`, { productId: 'chat' });
		h.clock.advance(1000);
		await owner.del(`${site}/products/notes`);
		h.clock.advance(1000);
		const blocked = await owner.del(site, { confirm: 'shop.example.com' });
		h.clock.advance(1000);
		expect(blocked.status).toBe(409);
		await owner.del(`${site}/products/chat`);
		h.clock.advance(1000);
		expect((await owner.del(site, { confirm: 'shop.example.com' })).status).toBe(200);
		h.clock.advance(1000);
		expect(notes.notices.at(-1)).toEqual({ type: 'website.deleted', websiteId: w1 });
		expect(chat.notices.at(-1)).toEqual({ type: 'website.deleted', websiteId: w1 });
		// the status of a deleted website is 404 for its products
		const status = await h.productCall(notes, 'GET', `/v1/product/websites/${w1}/status`);
		h.clock.advance(1000);
		expect(status.status).toBe(404);
	});
});
