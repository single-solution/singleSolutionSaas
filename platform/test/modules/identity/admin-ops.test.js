/**
 * Admin operations APIs: merchant notes (append-only, audited), merchant search (`?q=` name / e-mail prefix,
 * migration backfill) and the audit log search (filters, cursor).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS } from '../../../src/infra/schema.js';
import { nameKey, parseMerchantQuery, prefixPattern } from '../../../src/modules/identity/core/search.js';
import { identityModule } from '../../../src/modules/identity/index.js';
import { C } from '../../../src/modules/identity/schema.js';
import { parseAuditQuery, presentAuditEntry } from '../../../src/modules/system/ops.js';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

describe('merchant notes and search', () => {
	it('appends audited notes and searches merchants by name or e-mail prefix', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const support = await h.staffUser('support@example.com', ['support'], { creator: root.client });
		const a = await h.signupOwner('anna@shop.test', { merchantName: 'Café Ölmühle' });
		const b = await h.signupOwner('bob@else.test', { merchantName: 'Cafeteria Bob' });
		await h.signupOwner('carl@third.test', { merchantName: 'Zeta' });

		// notes
		const notes = `/v1/admin/merchants/${a.merchantId}/notes`;
		expect((await root.client.get(notes)).json).toEqual({ items: [] });
		expect((await root.client.post(notes, { body: '' })).status).toBe(422);
		expect((await support.client.post(notes, { body: 'hi' })).status).toBe(403);
		const added = await root.client.post(notes, { body: 'Called about invoices.' });
		expect(added.status).toBe(201);
		expect(added.json).toMatchObject({
			body: 'Called about invoices.',
			by: { staffId: root.staffId, email: 'root@example.com' },
		});
		h.clock.advance(1000);
		await root.client.post(notes, { body: 'Second note.' });
		const listed = await support.client.get(notes);
		expect(listed.json.items.map((/** @type {any} */ n) => n.body)).toEqual(['Second note.', 'Called about invoices.']);
		expect((await root.client.get(`${notes}?limit=1`)).json.items).toHaveLength(1);
		expect((await root.client.get('/v1/admin/merchants/mer_0000000000000000000000000z/notes')).status).toBe(404);
		const entry = await h.db.collection(COLLECTIONS.audit).findOne({ action: 'merchant.note_added' }, { sort: { at: 1 } });
		expect(entry).toMatchObject({ merchantId: a.merchantId, after: { length: 22 } });
		expect(JSON.stringify(entry)).not.toContain('Called about invoices');

		// search
		/** @param {string} q */
		const search = async (q) =>
			(await root.client.get(`/v1/admin/merchants?q=${encodeURIComponent(q)}`)).json.items
				.map((/** @type {any} */ m) => m.name)
				.sort();
		expect(await search('cafe')).toEqual(['Cafeteria Bob', 'Café Ölmühle']);
		expect(await search('CAFÉ Ö')).toEqual(['Café Ölmühle']);
		expect(await search('caf.*')).toEqual([]);
		expect(await search('bob@')).toEqual(['Cafeteria Bob']);
		expect(await search('ANNA@shop')).toEqual(['Café Ölmühle']);
		expect(await search('nobody@')).toEqual([]);
		expect(await search('zeta')).toEqual(['Zeta']);
		expect((await root.client.get(`/v1/admin/merchants?q=${'x'.repeat(121)}`)).status).toBe(400);
		const paged = await root.client.get('/v1/admin/merchants?q=caf&limit=1');
		expect(paged.json.items).toHaveLength(1);
		const next = await root.client.get(`/v1/admin/merchants?q=caf&limit=1&cursor=${paged.json.nextCursor}`);
		expect(next.json.items).toHaveLength(1);
		expect(next.json.items[0].merchantId).not.toBe(paged.json.items[0].merchantId);
		// renames keep the search key in sync
		await b.client.patch(`/v1/merchants/${b.merchantId}`, { name: 'Bistro Bob' });
		expect(await search('bistro')).toEqual(['Bistro Bob']);
		expect(await search('cafeteria')).toEqual([]);

		// migration: merchants created before nameKey existed are backfilled
		await h.db.collection(C.merchants).updateOne({ _id: /** @type {any} */ (a.merchantId) }, { $unset: { nameKey: '' } });
		expect(await search('café')).toEqual([]);
		const migration = /** @type {any} */ (identityModule).migrations.find((/** @type {any} */ m) => m.id.includes('name-key'));
		expect(await migration.plan()).toHaveLength(1);
		await migration.up({ db: h.db });
		expect(await search('café')).toEqual(['Café Ölmühle']);
	});

	it('search helpers', () => {
		expect(nameKey('  Café   Ölmühle ')).toBe('cafe olmuhle');
		expect(nameKey(null)).toBe('');
		expect(prefixPattern('a.b*(c)')).toBe('^a\\.b\\*\\(c\\)');
		expect(parseMerchantQuery('Bob@X')).toEqual({ kind: 'email', prefix: 'bob@x' });
		expect(parseMerchantQuery(' Café ')).toEqual({ kind: 'name', prefix: 'cafe' });
		expect(parseMerchantQuery('')).toBeNull();
		expect(parseMerchantQuery('́')).toBeNull();
		expect(parseMerchantQuery(5)).toBeNull();
		expect(parseMerchantQuery('x'.repeat(121))).toBeNull();
	});
});

describe('audit log', () => {
	it('searches the audit log', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const finance = await h.staffUser('fin@example.com', ['finance'], { creator: root.client });
		const owner = await h.signupOwner('owner@example.com', { merchantName: 'Acme' });

		// audit search
		const all = await finance.client.get('/v1/admin/audit');
		expect(all.status).toBe(200);
		expect(all.json.items.length).toBeGreaterThan(2);
		expect(all.json.items[0]).not.toHaveProperty('ip');
		const ats = all.json.items.map((/** @type {any} */ e) => e.at);
		expect([...ats].sort().reverse()).toEqual(ats);
		const byActor = await root.client.get(`/v1/admin/audit?actorId=${root.staffId}`);
		expect(byActor.json.items.every((/** @type {any} */ e) => e.actor.id === root.staffId)).toBe(true);
		const byAction = await root.client.get('/v1/admin/audit?action=staff.created');
		expect(byAction.json.items.map((/** @type {any} */ e) => e.action)).toEqual(['staff.created']);
		const byPrefix = await root.client.get('/v1/admin/audit?action=staff.*');
		expect(byPrefix.json.items.length).toBeGreaterThan(1);
		expect(byPrefix.json.items.every((/** @type {any} */ e) => e.action.startsWith('staff.'))).toBe(true);
		const byTarget = await root.client.get(`/v1/admin/audit?targetId=${owner.merchantId}`);
		expect(byTarget.json.items.every((/** @type {any} */ e) => e.target.id === owner.merchantId)).toBe(true);
		expect((await root.client.get('/v1/admin/audit?actorId=a b')).status).toBe(422);
		expect((await root.client.get('/v1/admin/audit?action=Bad Action')).status).toBe(422);
		// cursor pagination covers everything exactly once
		const seen = [];
		let cursor = '';
		for (let i = 0; i < 50; i += 1) {
			const page = await root.client.get(`/v1/admin/audit?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
			seen.push(...page.json.items.map((/** @type {any} */ e) => e.auditId));
			if (!page.json.nextCursor) break;
			cursor = page.json.nextCursor;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toHaveLength((await root.client.get('/v1/admin/audit?limit=100')).json.items.length);
		expect((await root.client.get('/v1/admin/audit?cursor=bad!')).status).toBe(400);
		expect((await owner.client.get('/v1/admin/audit')).status).toBe(401);
	});

	it('audit query parsing and presentation', () => {
		expect(parseAuditQuery({ action: 'credits.*', actorId: 'stf_1', targetId: '', x: 'y' })).toEqual({
			ok: true,
			value: { action: 'credits.*', actorId: 'stf_1' },
		});
		expect(parseAuditQuery({ action: 'Bad', targetId: 'a b' })).toMatchObject({
			ok: false,
			errors: [{ path: '/targetId' }, { path: '/action' }],
		});
		expect(
			presentAuditEntry({
				_id: 'a',
				at: new Date(0),
				action: 'x.y',
				actor: { type: 'system', id: 's' },
				target: {},
				ip: '1.2.3.4',
			}),
		).toEqual({
			auditId: 'a',
			at: '1970-01-01T00:00:00.000Z',
			action: 'x.y',
			actor: { type: 'system', id: 's' },
			target: {},
			merchantId: null,
			reason: null,
			before: null,
			after: null,
			requestId: null,
		});
	});
});
