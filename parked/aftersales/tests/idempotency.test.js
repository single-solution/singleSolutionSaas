/** Idempotency-Keys are scoped to the caller: one caller reusing another caller's key never sees or changes their record. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, WEBSITE, createHarness } from './harness.js';
import { callerOf, requestKey } from '../api/routes.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('caller-scoped Idempotency-Keys', () => {
	it('derives different ids for different callers, routes and websites', () => {
		const ctx = { idempotencyKey: 'k1', websiteId: WEBSITE, method: 'POST', path: '/v1/claims', session: null, website: null };
		const a = requestKey(ctx, { via: 'identity', subject: 'cus_a' });
		expect(requestKey(ctx, { via: 'identity', subject: 'cus_a' })).toBe(a);
		expect(requestKey(ctx, { via: 'identity', subject: 'cus_b' })).not.toBe(a);
		expect(requestKey(ctx, { via: 'token', purchaseId: 'pur_1' })).not.toBe(a);
		expect(requestKey({ ...ctx, path: '/v1/messages' }, { via: 'identity', subject: 'cus_a' })).not.toBe(a);
		expect(requestKey({ ...ctx, idempotencyKey: undefined })).not.toBe(requestKey({ ...ctx, idempotencyKey: undefined }));
		expect(callerOf(ctx)).toBe('anonymous');
		expect(callerOf({ session: { subject: 'usr_1' } })).toBe('session:usr_1');
		expect(callerOf({ session: null, website: { kind: 'sk', keyId: 'key_1' } })).toBe('key:sk:key_1');
	});

	it('gives caller B a fresh claim and photo when it reuses caller A’s key', async () => {
		const a = await h.order({ subject: 'cus_a1' });
		const b = await h.order({ subject: 'cus_b1', email: 'b@example.com' });
		/** @param {string} purchaseId */
		const body = (purchaseId) => ({
			purchaseId,
			type: 'exchange',
			reason: 'wrong_item',
			lines: [{ lineId: 'itm_1:var_1', quantity: 1 }],
		});
		const first = await h.call('POST', '/v1/claims', { as: 'cus_a1', body: body(a.purchaseId), idempotencyKey: 'shared-key' });
		const photoA = await h.call('POST', '/v1/claim-photos', {
			as: 'cus_a1',
			body: { contentType: 'image/jpeg', size: 10 },
			idempotencyKey: 'shared-photo',
		});
		expect(first.status).toBe(201);
		h.clock.advance(25 * HOUR); // past app-kit's 24 h duplicate refusal
		const second = await h.call('POST', '/v1/claims', { as: 'cus_b1', body: body(b.purchaseId), idempotencyKey: 'shared-key' });
		expect(second.status).toBe(201);
		expect(second.json.id).not.toBe(first.json.id);
		expect(second.json.purchaseId).toBe(b.purchaseId);
		const stored = await h.collection('claims').findOne({ websiteId: WEBSITE, id: first.json.id });
		expect(stored?.purchaseId).toBe(a.purchaseId);
		const photoB = await h.call('POST', '/v1/claim-photos', {
			as: 'cus_b1',
			body: { contentType: 'image/png', size: 20 },
			idempotencyKey: 'shared-photo',
		});
		expect(photoB.status).toBe(201);
		expect(photoB.json.id).not.toBe(photoA.json.id);
		h.clock.advance(-25 * HOUR);
	});

	it('refuses a derived id that belongs to another caller (defence in depth)', async () => {
		const { service } = h.aftersales;
		const site = /** @type {any} */ (await h.aftersales.siteFor(WEBSITE));
		const a = await h.order({ subject: 'cus_a2' });
		const b = await h.order({ subject: 'cus_b2', email: 'b2@example.com' });
		const value = /** @type {any} */ ({
			purchaseId: a.purchaseId,
			type: 'exchange',
			reason: 'wrong_item',
			details: '',
			lines: [{ lineId: 'itm_1:var_1', quantity: 1, serial: null }],
			photoIds: [],
			token: null,
			raw: {},
		});
		const made = await service.submit(site, { value, who: { via: 'identity', subject: 'cus_a2' }, key: 'forged' });
		expect(made.ok).toBe(true);
		const again = await service.submit(site, { value, who: { via: 'identity', subject: 'cus_a2' }, key: 'forged' });
		expect(again).toMatchObject({ ok: true, created: false });
		const stolen = await service.submit(site, {
			value: { ...value, purchaseId: b.purchaseId },
			who: { via: 'identity', subject: 'cus_b2' },
			key: 'forged',
		});
		expect(stolen).toMatchObject({ ok: false, reason: 'duplicate_request' });
		const sameClaimOtherCustomer = await service.submit(site, {
			value,
			who: { via: 'identity', subject: 'cus_b2' },
			key: 'forged',
		});
		expect(sameClaimOtherCustomer).toMatchObject({ ok: false, reason: 'duplicate_request' });

		const upload = { contentType: 'image/jpeg', size: 5, key: 'forged-photo' };
		expect((await service.createUpload(site, { ...upload, owner: 'customer:cus_a2' })).ok).toBe(true);
		expect(await service.createUpload(site, { ...upload, owner: 'customer:cus_b2' })).toMatchObject({
			ok: false,
			reason: 'duplicate_request',
		});

		const claimA = /** @type {any} */ (made).claim;
		const claimB = await service.submit(site, {
			value: { ...value, purchaseId: b.purchaseId },
			who: { via: 'identity', subject: 'cus_b2' },
			key: 'claim-b2',
		});
		const actor = { type: 'customer' };
		const posted = await service.postMessage(
			site,
			{ claimId: claimA.id, body: 'Hello there' },
			{ via: 'identity', subject: 'cus_a2' },
			{ actor, key: 'forged-message' },
		);
		expect(posted.ok).toBe(true);
		const hijack = await service.postMessage(
			site,
			{ claimId: /** @type {any} */ (claimB).claim.id, body: 'Hello there' },
			{ via: 'identity', subject: 'cus_b2' },
			{ actor, key: 'forged-message' },
		);
		expect(hijack).toMatchObject({ ok: false, reason: 'duplicate_request' });
	});
});
