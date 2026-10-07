import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { APP, APP2, HOUR, M1, M2, STAFF, W1, W2, W3, bootCommerce } from './fixtures.js';

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

let n = 0;
const idem = () => ({ 'idempotency-key': `k-${(n += 1)}` });

describe('commerce routes and tenant isolation', () => {
	it('enforces merchant, admin role (PLAN 0.2) and product boundaries on every route', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_routes', clock });
		await h.credit(M1, 100_000);
		const owner1 = await h.login({ kind: 'merchant', subject: M1 });
		const owner2 = await h.login({ kind: 'merchant', subject: M2 });
		const admin = await h.login({ kind: 'admin', subject: 'adm_owner' });
		const support = await h.login({ kind: 'admin', subject: 'adm_support' });

		// products on websites: Owner and Support add them; merchants only view (PLAN 0.2)
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, {
					headers: { ...owner1, ...idem() },
					body: { appId: APP, planCode: 'starter' },
				})
			).status,
		).toBe(403);
		const created = await h.call('POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, {
			headers: { ...admin, ...idem() },
			body: { appId: APP, planCode: 'starter' },
		});
		expect(created.status).toBe(201);
		const sub1 = created.json.subscription.subscriptionId;
		const other = await h.call('POST', `/v1/merchants/${M2}/websites/${W3}/subscriptions`, {
			headers: { ...support, ...idem() },
			body: { appId: APP },
		});
		expect(other.status).toBe(201);
		const sub3 = other.json.subscription.subscriptionId;
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W3}/subscriptions`, {
					headers: { ...admin, ...idem() },
					body: { appId: APP2 },
				})
			).status,
		).toBe(404);
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W2}/subscriptions`, {
					headers: { ...admin, ...idem() },
					body: { appId: 'nope' },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W2}/subscriptions`, {
					headers: { ...admin, ...idem() },
					body: { appId: APP2 },
				})
			).status,
		).toBe(201);

		// cross-merchant access is refused before any lookup; foreign ids under one's own merchant are not found
		const base1 = `/v1/merchants/${M1}/subscriptions/${sub1}`;
		for (const [method, path, body] of /** @type {const} */ ([
			['GET', `/v1/merchants/${M1}/subscriptions`, undefined],
			['GET', base1, undefined],
			['PUT', `${base1}/elements/reports`, { enabled: true }],
			['PUT', `${base1}/plan`, { planCode: 'pro' }],
			['POST', `${base1}/pause`, {}],
			['POST', `${base1}/resume`, {}],
			['POST', `${base1}/cancel`, {}],
			['GET', `/v1/merchants/${M1}/billing`, undefined],
			['GET', `/v1/merchants/${M1}/usage`, undefined],
			['GET', `/v1/merchants/${M1}/receipts`, undefined],
		])) {
			const res = await h.call(method, path, {
				headers: { ...owner2, ...(method === 'POST' ? idem() : {}) },
				...(body ? { body } : {}),
			});
			expect([method, path, res.status]).toEqual([method, path, 403]);
		}
		expect((await h.call('GET', `/v1/merchants/${M2}/subscriptions/${sub1}`, { headers: owner2 })).status).toBe(404);
		expect(
			(
				await h.call('PUT', `/v1/merchants/${M2}/subscriptions/${sub1}/elements/reports`, {
					headers: owner2,
					body: { enabled: true },
				})
			).status,
		).toBe(404);

		// own merchant
		const list = await h.call('GET', `/v1/merchants/${M1}/subscriptions`, { headers: owner1 });
		expect(list.json.items.map((/** @type {any} */ s) => s.websiteId).sort()).toEqual([W1, W2]);
		expect(list.json.items.some((/** @type {any} */ s) => s.subscriptionId === sub3)).toBe(false);
		expect((await h.call('GET', base1, { headers: owner1 })).json.subscription.subscriptionId).toBe(sub1);
		// switching features is Owner and Support only (merchants see them read-only)
		expect((await h.call('PUT', `${base1}/elements/reports`, { headers: owner1, body: { enabled: true } })).status).toBe(403);
		expect((await h.call('PUT', `${base1}/elements/reports`, { headers: support, body: { enabled: true } })).status).toBe(200);
		expect((await h.call('PUT', `${base1}/elements/reports`, { headers: admin, body: { enabled: 'yes' } })).status).toBe(422);
		expect((await h.call('PUT', `${base1}/elements/ai_copy`, { headers: admin, body: { enabled: true } })).status).toBe(200);
		expect((await h.call('PUT', `${base1}/plan`, { headers: owner1, body: { planCode: 'pro' } })).status).toBe(403);
		expect((await h.call('PUT', `${base1}/plan`, { headers: admin, body: {} })).status).toBe(422);
		expect(
			(await h.call('PUT', `${base1}/plan`, { headers: admin, body: { planCode: 'pro' } })).json.subscription.planCode,
		).toBe('pro');
		expect(
			(await h.call('POST', `${base1}/pause`, { headers: { ...admin, ...idem() }, body: { reason: 'Bad Reason' } })).status,
		).toBe(422);
		expect(
			(await h.call('POST', `${base1}/pause`, { headers: { ...admin, ...idem() }, body: { reason: 'holiday' } })).json
				.subscription.status,
		).toBe('paused');
		expect((await h.call('POST', `${base1}/resume`, { headers: { ...admin, ...idem() } })).json.subscription.status).toBe(
			'active',
		);

		// money views (each runs the check first)
		await h.service.recordPriceList({ appId: APP, features: [{ key: 'codes', name: 'Codes', price: 1000 }] });
		await h.service.recordProductAdded({ merchantId: M1, websiteId: W1, appId: APP });
		await h.service.recordSwitches({ merchantId: M1, websiteId: W1, appId: APP, on: ['codes'] });
		clock.set(T0 + 2 * HOUR + 5 * 60_000);
		const billing = await h.call('GET', `/v1/merchants/${M1}/billing`, { headers: owner1 });
		expect(billing.json).toMatchObject({ merchantId: M1, status: 'active', balance: 97_000, dailySpend: 24_000, daysLeft: 4 });
		const usage = await h.call('GET', `/v1/merchants/${M1}/usage?from=2026-10-01&to=2026-10-01&websiteId=${W1}`, {
			headers: owner1,
		});
		expect(usage.json.rows).toMatchObject([{ feature: 'codes', featureName: 'Codes', hours: 3, amount: 3000 }]);
		expect((await h.call('GET', `/v1/merchants/${M1}/usage?from=nope`, { headers: owner1 })).status).toBe(422);

		// adding credits: Owner and Finance only, with the receipt form (PLAN 0.5.8)
		const receipt = (/** @type {Record<string, string>} */ who, /** @type {unknown} */ body) =>
			h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...who, ...idem() }, body });
		const form = { credits: 50, amountPaid: 'PKR 5,000', method: 'Bank transfer', reference: 'wire-77' };
		expect((await receipt(owner1, form)).status).toBe(401);
		expect((await receipt(support, form)).status).toBe(403);
		expect((await receipt(admin, { ...form, credits: 0 })).status).toBe(422);
		const key = idem();
		const added = await h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...admin, ...key }, body: form });
		expect(added.status).toBe(201);
		expect(added.json.receipt).toMatchObject({ credits: 50_000, amountPaid: 'PKR 5,000', method: 'Bank transfer' });
		expect(added.json.summary.balance).toBe(147_000);
		// a double submit with the same one-time key saves once
		const again = await h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...admin, ...key }, body: form });
		expect(again.headers.get('idempotent-replayed')).toBe('true');
		const finance = await h.login({ kind: 'admin', subject: 'adm_finance' });
		expect((await receipt(finance, { ...form, reference: undefined })).status).toBe(201);
		// the amount paid is shown to admins only
		const own = await h.call('GET', `/v1/merchants/${M1}/receipts`, { headers: owner1 });
		expect(own.json.items).toHaveLength(3);
		expect(own.json.items.every((/** @type {any} */ r) => !('amountPaid' in r))).toBe(true);
		const seen = await h.call('GET', `/v1/merchants/${M1}/receipts`, { headers: support });
		expect(seen.json.items[1]).toMatchObject({ amountPaid: 'PKR 5,000' });
		expect((await h.portal.shared.audit.list({ merchantId: M1 })).map((a) => a.action)).toContain('credits.added');

		// Credits and billing: Support views, Finance views
		for (const path of [
			`/v1/admin/merchants/${M1}/day-charges`,
			`/v1/admin/billing/merchants?ids=${M1},${M2},bad`,
			'/v1/admin/billing/attention',
			'/v1/admin/billing/receipts?method=Bank%20transfer',
			'/v1/admin/billing/charges?by=merchant',
		]) {
			expect([path, (await h.call('GET', path, { headers: support })).status]).toEqual([path, 200]);
			expect((await h.call('GET', path, { headers: owner1 })).status).toBe(401);
		}
		expect(
			(await h.call('GET', `/v1/admin/billing/merchants?ids=${M1},${M2},bad`, { headers: finance })).json.items,
		).toHaveLength(2);
		expect(
			(await h.call('GET', '/v1/admin/billing/receipts?method=Bank%20transfer', { headers: finance })).json.items,
		).toHaveLength(3);
		expect((await h.call('GET', '/v1/admin/billing/charges?by=week', { headers: finance })).status).toBe(422);
		expect((await h.call('GET', '/v1/admin/billing/charges?from=x', { headers: finance })).status).toBe(422);
		expect((await h.call('GET', '/v1/admin/billing/receipts?merchantId=x', { headers: finance })).status).toBe(422);
		// the removed money routes are gone
		for (const path of [`/v1/merchants/${M1}/balance`, `/v1/merchants/${M1}/spend-cap`, '/v1/admin/commerce/alerts'])
			expect((await h.call('GET', path, { headers: admin })).status).toBe(404);

		// product routes: only the app's own subscription
		const app1 = await h.productAuth(APP);
		const app2 = await h.productAuth(APP2);
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`)).status).toBe(401);
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`, { headers: owner1 })).status).toBe(401);
		const doc = await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`, { headers: await app1() });
		expect(doc.status).toBe(200);
		expect(doc.json.document.split('.')).toHaveLength(3);
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`, { headers: await app2() })).status).toBe(404);
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W3}`, { headers: await app2() })).status).toBe(404);
		expect((await h.call('GET', '/v1/product/entitlements', { headers: await app1() })).status).toBe(422);
		const usageBatch = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await app2()), ...idem() },
			body: {
				records: [
					{
						websiteId: W1,
						subscriptionId: sub1,
						unit: 'redemption',
						quantity: 1,
						idempotencyKey: 'x1',
						occurredAt: '2026-10-01T10:00:00Z',
					},
				],
			},
		});
		expect(usageBatch.json.results).toEqual([{ idempotencyKey: 'x1', status: 'rejected', reason: 'subscription_mismatch' }]);
		expect((await h.call('POST', '/v1/product/usage', { headers: await app1(), body: { records: [] } })).status).toBe(428);

		// cancel last
		expect(
			(await h.call('POST', `${base1}/cancel`, { headers: { ...admin, ...idem() }, body: { reason: 'done' } })).json
				.subscription.status,
		).toBe('cancelled');
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`, { headers: await app1() })).status).toBe(410);
		expect(STAFF.type).toBe('admin');
	});
});
