import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeyResolver, verifyEntitlementDocument } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { APP, APP2, HOUR, M1, M2, STAFF, W1, W2, W3, bootCommerce, couponsManifest } from './fixtures.js';

// Mongo-backed tests share the machine with other suites: allow for slow replica-set start-up and I/O.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const MERCHANT_ACTOR = { type: 'merchant', id: M1, merchantId: M1 };

/**
 * @param {any} h @param {string} jws
 * @returns {Promise<any>}
 */
const decode = async (h, jws) =>
	(
		await verifyEntitlementDocument({
			token: jws,
			keyResolver: createKeyResolver({ jwks: h.portal.shared.keys.jwks() }),
			now: h.clock.now,
		})
	).payload;

describe('subscribe and documents', () => {
	it('needs no credits, pins the price book and signs documents', async () => {
		const clock = createClock(T0 + 30 * 60_000); // 10:30
		const h = await bootCommerce({ mongo, dbName: 'cm_flow_basic', clock });
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(sub).toMatchObject({ status: 'active', planCode: 'starter', priceBookVersion: '2026-01', manifestVersion: 1 });
		await expect(h.service.subscribe({ websiteId: W1, appId: APP, actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
		});

		const jws = await h.service.documentFor({ websiteId: W1, appId: APP });
		const doc = await decode(h, jws);
		expect(doc).toMatchObject({
			subscriptionId: sub.subscriptionId,
			domain: 'shop.example.com',
			env: 'live',
			version: 1,
			planCode: 'starter',
			dataScope: { prefix: 'ss_coupon_box_' },
			runtime: { state: 'active' },
			resources: [{ kind: 'database', ref: 'con_db1', status: 'connected' }],
		});
		expect(doc.elements).toMatchObject({ codes: { enabled: true }, apply_box: { enabled: true }, reports: { enabled: false } });
		expect(await h.service.documentFor({ websiteId: W1, appId: APP })).toBe(jws); // cached
		expect(h.world.events.map((e) => e.type)).toEqual(['subscription.activated@1', 'entitlement.changed@1']);
	});
});

const MIN = 60_000;

describe('subscription lifecycle', () => {
	it('pauses and resumes, emitting lifecycle events', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_pause', clock });
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		clock.set(T0 + 20 * MIN);
		const paused = await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR, reason: 'holiday' });
		expect(paused).toMatchObject({ status: 'paused', holds: ['paused'] });
		expect(await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'paused',
		});
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.runtime).toEqual({ state: 'paused', reason: 'paused' });
		expect(doc.elements.codes).toEqual({ enabled: false, reason: 'paused' });
		clock.set(T0 + 3 * HOUR + 40 * MIN); // 13:40
		expect(await h.service.resume({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'active',
		});
		clock.set(T0 + 4 * HOUR + 10 * MIN); // 14:10 pause and resume within one hour → billed once
		await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR });
		clock.set(T0 + 4 * HOUR + 20 * MIN);
		await h.service.resume({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR });
		const types = h.world.events.map((e) => `${e.type}:${e.data.reason ?? ''}`);
		expect(types).toEqual(expect.arrayContaining(['subscription.paused@1:holiday', 'subscription.resumed@1:paused_released']));
		await expect(
			h.service.pause({ subscriptionId: 'sub_zzzzzzzzzzzzzzzzzzzzzzzzzz', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('merchants stay within the plan for element switches, staff may exceed it', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_elements', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		clock.set(T0 + 15 * MIN);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'ai_copy', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'nope', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
		const staffSwitch = await h.service.setElement({ subscriptionId, elementKey: 'ai_copy', enabled: true, actor: STAFF });
		expect(staffSwitch.switches).toEqual({ website: { reports: true }, admin: { ai_copy: true } });
		let doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.reports).toEqual({ enabled: true });
		expect(doc.elements.ai_copy).toEqual({ enabled: false, reason: 'resource_missing:ai' });
		clock.set(T0 + HOUR + 30 * MIN); // ai connected at 11:30
		h.world.resources.set(W1, [
			{ kind: 'database', ref: 'con_db1', status: 'connected' },
			{ kind: 'ai', ref: 'con_ai1', status: 'connected' },
		]);
		expect(await h.service.invalidateWebsite(W1)).toEqual({ invalidated: 1 });
		doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.ai_copy).toEqual({ enabled: true });
		clock.set(T0 + 3 * HOUR + 10 * MIN); // 13:10: codes off → apply_box and reports stop by dependency
		await h.service.setElement({ subscriptionId, elementKey: 'codes', enabled: false, actor: MERCHANT_ACTOR });
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'conflict',
		});
		doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements).toMatchObject({
			apply_box: { enabled: false, reason: 'dependency:codes' },
			reports: { enabled: false },
		});
	});

	it('plan changes pin the current price book and are validated against switches and dependencies', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_plan', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const v2 = couponsManifest({
			version: '2.0.0',
			priceBook: '2026-10',
			effectiveFrom: '2026-09-30T00:00:00Z',
			codesHourly: 2000,
		});
		v2.plans.push({ code: 'basic', name: 'Basic', elements: ['codes'] });
		const app = /** @type {any} */ (h.world.apps.get(APP));
		app.versions.set(2, v2);
		app.app.currentVersion = 2;
		clock.set(T0 + 5 * MIN);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		clock.set(T0 + 30 * MIN);
		await expect(h.service.changePlan({ subscriptionId, planCode: 'basic', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
			errors: [{ path: '/elements/reports' }],
		});
		await expect(h.service.changePlan({ subscriptionId, planCode: 'gold', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'validation_failed',
		});
		const pro = await h.service.changePlan({ subscriptionId, planCode: 'pro', actor: MERCHANT_ACTOR });
		expect(pro).toMatchObject({ planCode: 'pro', priceBookVersion: '2026-10', manifestVersion: 2, productVersion: '2.0.0' });
		expect(pro.pins.map((/** @type {any} */ p) => p.version)).toEqual(['2026-01', '2026-10']);
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc).toMatchObject({ planCode: 'pro', priceBookVersion: '2026-10' });
		await h.service.setElement({ subscriptionId, elementKey: 'codes', enabled: false, actor: MERCHANT_ACTOR });
		await expect(h.service.changePlan({ subscriptionId, planCode: 'starter', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
		});
		expect(await h.service.changePlan({ subscriptionId, planCode: null, actor: STAFF })).toMatchObject({ planCode: null });
	});

	it('records usage exactly once and blocks exhausted quotas (usage is never charged)', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_usage', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const other = await h.service.subscribe({
			websiteId: W3,
			appId: APP2,
			actor: { type: 'admin', id: 'adm_owner', role: 'owner' },
		});
		const auth = await h.productAuth(APP);
		const record = (/** @type {string} */ key, /** @type {number} */ quantity, extra = {}) => ({
			websiteId: W1,
			subscriptionId,
			unit: 'redemption',
			quantity,
			idempotencyKey: key,
			occurredAt: '2026-10-01T10:00:00Z',
			...extra,
		});
		clock.set(T0 + 10 * MIN);
		const body = {
			records: [
				record('a', 3),
				record('b', 5),
				record('a', 3),
				record('c', 1, { websiteId: W2 }),
				record('d', 1, { unit: 'sms' }),
				record('e', 1, { subscriptionId: 'sub_zzzzzzzzzzzzzzzzzzzzzzzzzz' }),
				record('f', -1),
				record('g', 1, { subscriptionId: other.subscriptionId, websiteId: W3 }),
			],
		};
		const first = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-1' },
			body,
		});
		expect(first.status).toBe(200);
		expect(first.json.results.map((/** @type {any} */ r) => `${r.idempotencyKey}:${r.status}:${r.reason ?? ''}`)).toEqual([
			'a:accepted:',
			'b:accepted:',
			'a:duplicate:',
			'c:rejected:subscription_mismatch',
			'd:rejected:unknown_unit',
			'e:rejected:not_subscribed',
			'f:rejected:invalid_quantity',
			'g:rejected:subscription_mismatch',
		]);
		const replay = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-1' },
			body,
		});
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		const again = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-2' },
			body,
		});
		expect(again.json.results.slice(0, 2).map((/** @type {any} */ r) => r.status)).toEqual(['duplicate', 'duplicate']);
		expect(
			(
				await h.call('POST', '/v1/product/usage', {
					headers: { ...(await auth()), 'idempotency-key': 'x' },
					body: { records: [] },
				})
			).status,
		).toBe(422);
		expect(await h.db.collection('commerce_usage').countDocuments({ subscriptionId })).toBe(2);

		const v1 = (await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).version;
		clock.set(T0 + HOUR + 10 * MIN); // 11:10: 15 more → 23 ≥ quota 20 (starter x-plan default)
		const more = await h.service.recordUsage({ appId: APP, records: [record('h', 15)] });
		expect(more.results[0]?.status).toBe('accepted');
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.version).toBe(v1 + 1);
		expect(doc.features['codes.redemptions']).toMatchObject({ value: 20, reason: 'quota_exhausted' });
		expect(doc.elements.codes).toEqual({ enabled: true });
		expect(
			h.world.events.filter((e) => e.type === 'entitlement.changed@1' && e.data.subscriptionId === subscriptionId),
		).toHaveLength(2);

		await expect(h.service.recordUsage({ appId: APP, records: [record('i', 1)] })).resolves.toMatchObject({
			results: [{ status: 'accepted' }],
		});
	});

	it('merchant suspension suspends every subscription; cancellation ends it', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_suspend', clock });
		const a = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		await h.service.subscribe({ websiteId: W2, appId: APP2, actor: MERCHANT_ACTOR });
		clock.set(T0 + 30 * MIN);
		expect(await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' })).toEqual({ changed: 2 });
		expect(await h.service.getSubscription(a.subscriptionId)).toMatchObject({ status: 'suspended' });
		expect((await decode(h, await h.service.documentFor({ websiteId: W2, appId: APP2 }))).runtime.state).toBe('suspended');
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'suspended' });
		await expect(h.service.subscribe({ websiteId: W2, appId: APP, actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'forbidden',
		});
		clock.set(T0 + 2 * HOUR + 30 * MIN);
		expect(await h.service.onMerchantStatus({ merchantId: M1, status: 'active' })).toEqual({ changed: 2 });
		clock.set(T0 + 3 * HOUR + 10 * MIN);
		const cancelled = await h.service.cancel({
			subscriptionId: a.subscriptionId,
			actor: MERCHANT_ACTOR,
			reason: 'too_expensive',
		});
		expect(cancelled.status).toBe('cancelled');
		expect(await h.service.cancel({ subscriptionId: a.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'cancelled',
		});
		await expect(h.service.documentFor({ websiteId: W1, appId: APP })).rejects.toMatchObject({ code: 'gone' });
		await expect(
			h.service.setElement({ subscriptionId: a.subscriptionId, elementKey: 'codes', enabled: true, actor: STAFF }),
		).rejects.toMatchObject({ code: 'gone' });
		await expect(h.service.pause({ subscriptionId: a.subscriptionId, actor: STAFF })).rejects.toMatchObject({ code: 'gone' });
		await expect(h.service.resume({ subscriptionId: a.subscriptionId, actor: STAFF })).rejects.toMatchObject({ code: 'gone' });
		await expect(
			h.service.changePlan({ subscriptionId: a.subscriptionId, planCode: null, actor: STAFF }),
		).rejects.toMatchObject({ code: 'gone' });
		expect(await h.service.invalidate(a.subscriptionId)).toEqual({ invalidated: true, version: null });
		// a new subscription after cancellation is allowed
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'active' });
		expect(await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'active',
		});
		expect(h.world.events.map((e) => e.type)).toEqual(expect.arrayContaining(['subscription.cancelled@1']));
		expect((await h.service.subscriptionsForWebsite(W1)).map((s) => s.status)).toEqual(['cancelled', 'active']);
		expect(await h.service.invalidate('sub_zzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({ invalidated: false, version: null });
	});
});

describe('entitlement documents', () => {
	it('bumps the version only when the content hash changes and re-signs near validUntil', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_docs', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const changed = () => h.world.events.filter((e) => e.type === 'entitlement.changed@1').length;
		expect(changed()).toBe(1);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 1 });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 1 });
		expect(changed()).toBe(1);
		const first = await h.service.documentFor({ websiteId: W1, appId: APP });
		clock.advance(9 * MIN); // within 2 min of validUntil → re-signed, same version
		const resigned = await h.service.documentFor({ websiteId: W1, appId: APP });
		expect(resigned).not.toBe(first);
		expect((await decode(h, resigned)).version).toBe(1);
		h.world.layers.set(subscriptionId, { website: { features: { 'codes.redemptions': { value: 15 } } } });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 });
		expect(changed()).toBe(2);
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.features['codes.redemptions']).toMatchObject({ value: 15, source: 'website_override' });
		const event = h.world.events.at(-1);
		expect(event).toMatchObject({
			type: 'entitlement.changed@1',
			data: { version: 2, websiteId: W1 },
			target: { appIds: [APP], websiteId: W1 },
		});
		expect(event?.data.document).toBe(await h.service.documentFor({ websiteId: W1, appId: APP }));
		await expect(h.service.documentFor({ websiteId: W2, appId: APP })).rejects.toMatchObject({ code: 'not_found' });
		await expect(h.service.documentFor({ websiteId: /** @type {any} */ (5), appId: APP })).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('carries the website identity issuer and bumps the version when it changes', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_identity', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const plain = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(plain).not.toHaveProperty('identity');
		const identity = {
			issuer: 'https://login.shop.example.com/',
			jwks: [
				{ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', kid: 'k1', alg: 'EdDSA', use: 'sig' },
			],
			claimMap: { subject: 'sub' },
		};
		h.world.identities.set(W1, identity);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.identity).toEqual(identity);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 }); // unchanged
		h.world.identities.set(W1, { ...identity, audience: 'shop' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 3 });
		const preview = await h.service.previewDocument({ subscriptionId, layers: {} });
		expect(preview).toMatchObject({ version: 3, identity: { audience: 'shop' } });
		h.world.identities.delete(W1);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 4 });
	});

	it('carries the website settings section, hashes it, and reports resource needs (F.16)', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_website', clock });
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const plain = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(plain).not.toHaveProperty('website');
		const before = plain.version;
		const site = /** @type {any} */ (h.world.websites.get(W1));
		h.world.websites.set(W1, { ...site, timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 1 });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.website).toEqual({ timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 1 }); // unchanged
		h.world.websites.set(W1, { ...site, timeZone: 'Europe/Berlin', language: null, currency: null });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 2 });
		expect((await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).website).toEqual({
			timeZone: 'Europe/Berlin',
		});

		// starter: reports (database) and ai_copy (ai) are off → their kinds are needed only if enabled
		const needs = await h.service.resourceNeeds(W1);
		expect(needs.map((/** @type {any} */ n) => [n.kind, n.scope, n.neededNow, n.elements])).toEqual([
			['ai', 'element', false, ['ai_copy']],
			['database', 'element', false, ['reports']],
		]);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		const after = await h.service.resourceNeeds(W1);
		expect(after.find((/** @type {any} */ n) => n.kind === 'database')).toMatchObject({ neededNow: true, appId: APP });
		expect(await h.service.websitesOfApp(APP)).toEqual([W1]);
	});

	it('previews documents for configuration dry runs and invalidates every subscription of an app', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_preview', clock });
		const a = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		await h.service.subscribe({ websiteId: W3, appId: APP, actor: { type: 'admin', id: 'adm_owner', role: 'owner' } });
		expect(h.world.calls.lastHint).toMatchObject({ appId: APP });
		const events = h.world.events.length;
		const preview = await h.service.previewDocument({
			subscriptionId: a.subscriptionId,
			layers: { website: { features: { 'codes.redemptions': { value: 7 } } } },
		});
		expect(preview).toMatchObject({
			subscriptionId: a.subscriptionId,
			version: 2,
			features: { 'codes.redemptions': { value: 7 } },
		});
		const same = await h.service.previewDocument({ subscriptionId: a.subscriptionId, layers: {} });
		expect(same.version).toBe(1);
		expect(h.world.events.length).toBe(events); // nothing emitted or stored
		expect(
			(await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).features['codes.redemptions'].value,
		).toBe(20);
		h.world.layers.set(a.subscriptionId, {
			platform: { features: { 'codes.redemptions': { value: 3, locked: true } } },
		});
		expect(await h.service.invalidateApp(APP)).toEqual({ invalidated: 2 });
		expect(
			(await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).features['codes.redemptions'],
		).toMatchObject({
			value: 3,
			locked: true,
			source: 'platform_policy',
		});
		await h.service.cancel({ subscriptionId: a.subscriptionId, actor: MERCHANT_ACTOR });
		await expect(h.service.previewDocument({ subscriptionId: a.subscriptionId, layers: {} })).rejects.toMatchObject({
			code: 'gone',
		});
		expect(await h.service.invalidateApp(APP)).toEqual({ invalidated: 1 });
		expect(await h.service.getSubscription(a.subscriptionId, M2).catch((e) => e.code)).toBe('not_found');
		expect((await h.service.subscriptionsOfMerchant(M1)).map((s) => s.status)).toEqual(['cancelled']);
		// an inactive app takes no new subscriptions; existing ones keep working
		const entry = /** @type {any} */ (h.world.apps.get(APP));
		h.world.apps.set(APP, { ...entry, app: { ...entry.app, status: 'inactive' } });
		await expect(
			h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await h.service.documentFor({ websiteId: W3, appId: APP })).toBeTypeOf('string');
	});

	it('works without optional neighbours (no config, connectors or integration) and survives delivery failures', async () => {
		const h = await bootCommerce({
			mongo,
			dbName: 'cm_optional',
			options: { withConfig: false, withConnectors: false, withIntegration: false },
		});
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'pro', actor: MERCHANT_ACTOR });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.reports).toEqual({ enabled: false, reason: 'resource_missing:database' });
		expect(doc.resources).toEqual([]);
		const g = await bootCommerce({ mongo, dbName: 'cm_emit_fail' });
		g.world.failEmit = true;
		await expect(g.service.subscribe({ websiteId: W1, appId: APP, actor: MERCHANT_ACTOR })).resolves.toMatchObject({
			status: 'active',
		});
		expect(g.logs.some((l) => l.msg === 'control event not emitted')).toBe(true);
		expect(sub.status).toBe('active');
	});
});
