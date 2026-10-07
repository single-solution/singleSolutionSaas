/**
 * F.16: a product (Signups) asks to become a website's identity issuer — product API, eligibility (active
 * subscription + `capabilities.identityIssuer`), pending request, notification, approval / rejection, audit.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS } from '../../../src/infra/schema.js';
import { PORTAL_URL, boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

const ED = { ...generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }), kid: 'su-1' };

describe('product identity issuer requests', () => {
	it('stores a pending request the merchant approves or rejects; identical requests are no-ops', async () => {
		const h = await boot();
		const owner = await h.signupOwner('owner@shop.test');
		const created = await owner.admin.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'shop.example.com' });
		const websiteId = created.json.website.websiteId;
		const product = async (/** @type {unknown} */ body, id = websiteId) =>
			h.call('PUT', `/v1/product/websites/${id}/identity`, {
				body,
				headers: { authorization: `Bearer ${await h.catalog.assertion(PORTAL_URL, h.clock.now)}` },
			});
		const body = {
			issuer: 'https://signups.example.net/web_x',
			publicJwks: [ED],
			claimMap: { subject: 'sub', email: 'email' },
		};

		// eligibility: subscription, then the manifest capability
		expect((await product(body)).status).toBe(403);
		h.commerce.subscriptions.push({ appId: h.catalog.appId, websiteId, status: 'active' });
		const noCapability = await product(body);
		expect(noCapability.status).toBe(403);
		expect(noCapability.json.detail).toMatch(/identityIssuer/);
		h.catalog.capabilities.identityIssuer = true;
		expect((await product({ issuer: '' })).status).toBe(422);
		expect((await product(body, 'web_0000000000000000000000000z')).status).toBe(404);
		expect((await h.call('PUT', `/v1/product/websites/${websiteId}/identity`, { body })).status).toBe(401);

		const requested = await product(body);
		expect(requested.status).toBe(202);
		expect(requested.json).toMatchObject({
			status: 'pending',
			request: { websiteId, product: { appId: h.catalog.appId, name: 'Signups' }, kids: ['su-1'], issuer: body.issuer },
		});
		expect((await product(body)).status).toBe(202); // same request: still the one pending request
		expect(h.mailer.sent.filter((m) => m.template === 'issuer_request')).toHaveLength(1);
		expect(h.mailer.sent.at(-1)).toMatchObject({
			to: 'owner@shop.test',
			data: { productName: 'Signups', domain: 'shop.example.com' },
		});

		// the merchant sees it (Website → Identity, notifications); nothing is active yet
		const path = `/v1/merchants/${owner.merchantId}/websites/${websiteId}/identity`;
		expect((await owner.client.get(path)).json).toMatchObject({ issuer: null, request: { status: 'pending' } });
		expect(await h.service.identityFor(websiteId)).toBeNull();
		const notes = await owner.client.get(`/v1/merchants/${owner.merchantId}/notifications`);
		expect(notes.json.items).toEqual([
			expect.objectContaining({ kind: 'identity_issuer_request', websiteId, domain: 'shop.example.com' }),
		]);

		// reject → gone; a new request → approve → active, managed by the product, documents re-signed
		const rejected = await owner.client.post(`${path}/request/reject`, { reason: 'not now' });
		expect(rejected.json.request).toMatchObject({ status: 'rejected', reason: 'not now' });
		expect((await owner.client.get(path)).json.request).toBeNull();
		expect((await owner.client.post(`${path}/request/approve`, {})).status).toBe(404);
		await product(body);
		h.commerce.invalidated.length = 0;
		const approved = await owner.client.post(`${path}/request/approve`, {});
		expect(approved.status).toBe(200);
		expect(approved.json.issuer).toMatchObject({ issuer: body.issuer, managedBy: { appId: h.catalog.appId, slug: 'signups' } });
		expect(h.commerce.invalidated).toContain(websiteId);
		expect(await h.service.identityFor(websiteId)).toMatchObject({ issuer: body.issuer });
		// the active configuration again: no new approval needed
		const again = await product(body);
		expect(again.status).toBe(200);
		expect(again.json.status).toBe('active');

		const audit = h.db.collection(COLLECTIONS.audit);
		for (const action of [
			'website.identity_issuer_requested',
			'website.identity_request_rejected',
			'website.identity_request_approved',
			'website.identity_set',
		])
			expect(await audit.findOne({ action, 'target.websiteId': websiteId }), action).toBeTruthy();
		expect(await audit.findOne({ action: 'website.identity_issuer_requested' })).toMatchObject({
			actor: { type: 'product', id: h.catalog.appId },
		});

		// approval re-checks eligibility
		await product({ ...body, issuer: 'https://signups.example.net/v2' });
		h.commerce.subscriptions.length = 0;
		expect((await owner.client.post(`${path}/request/approve`, {})).status).toBe(403);
	});
});
