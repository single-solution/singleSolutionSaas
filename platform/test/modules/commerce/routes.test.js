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
		await h.credit(M2, 100_000);
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
			['GET', `/v1/merchants/${M1}/balance`, undefined],
			['GET', `/v1/merchants/${M1}/meter`, undefined],
			['GET', `/v1/merchants/${M1}/statement`, undefined],
			['GET', `/v1/merchants/${M1}/spend-cap`, undefined],
			['PUT', `/v1/merchants/${M1}/spend-cap`, { limit: 1 }],
			['DELETE', `/v1/merchants/${M1}/spend-cap`, undefined],
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

		// money views
		clock.set(T0 + 2 * HOUR + 5 * 60_000);
		// settlement happens on read: the balance below settles M1's complete hours first
		const balance = await h.call('GET', `/v1/merchants/${M1}/balance`, { headers: owner1 });
		expect(balance.json.balanceMillicredits).toBeLessThan(100_000);
		const meter = await h.call('GET', `/v1/merchants/${M1}/meter`, { headers: owner1 });
		expect(meter.json).toMatchObject({ merchantId: M1, burnRatePerHour: 1750 }); // pro without the ai resource
		expect(meter.json.hoursRemaining).toBe(Math.floor(balance.json.balanceMillicredits / 1750));
		const statement = await h.call('GET', `/v1/merchants/${M1}/statement?from=2026-10-01&websiteId=${W1}`, { headers: owner1 });
		expect(statement.json).toMatchObject({ websiteId: W1, openingBalanceMillicredits: null });
		expect(statement.json.entries.every((/** @type {any} */ e) => e.websiteId === W1)).toBe(true);
		expect((await h.call('GET', `/v1/merchants/${M1}/statement?from=nope`, { headers: owner1 })).status).toBe(422);
		const full = await h.call('GET', `/v1/merchants/${M1}/statement?from=2026-10-01`, { headers: owner1 });
		expect(full.json.openingBalanceMillicredits).toBe(0);
		expect(full.json.closingBalanceMillicredits).toBe(balance.json.balanceMillicredits);

		// monthly spend cap
		const cap = `/v1/merchants/${M1}/spend-cap`;
		expect((await h.call('PUT', cap, { headers: owner2, body: { limit: 5 } })).status).toBe(403);
		expect((await h.call('PUT', cap, { headers: owner1, body: { limit: 0 } })).status).toBe(422);
		expect((await h.call('PUT', cap, { headers: owner1, body: { limit: 1_000_000 } })).json.limit).toBe(1_000_000);
		expect((await h.call('GET', cap, { headers: owner1 })).json).toMatchObject({ limit: 1_000_000, reached: false });
		expect((await h.call('DELETE', cap, { headers: owner2 })).status).toBe(403);
		expect((await h.call('DELETE', cap, { headers: admin })).status).toBe(204);
		expect((await h.call('GET', cap, { headers: owner1 })).json.limit).toBeNull();

		// adding credits: Owner and Finance only
		const credit = (/** @type {Record<string, string>} */ who, /** @type {string} */ segment, /** @type {unknown} */ body) =>
			h.call('POST', `/v1/admin/merchants/${M1}/${segment}`, { headers: { ...who, ...idem() }, body });
		expect((await credit(owner1, 'credits', { amountMillicredits: 5, reference: 'x', note: 'n' })).status).toBe(401);
		expect((await credit(support, 'credits', { amountMillicredits: 5, reference: 'x', note: 'n' })).status).toBe(403);
		expect((await credit(admin, 'credits', { amountMillicredits: -5, reference: 'x', note: 'n' })).status).toBe(422);
		const added = await credit(admin, 'credits', { amountMillicredits: 50_000, reference: 'wire-77', note: 'bank transfer' });
		expect(added.status).toBe(201);
		expect(added.json.entry).toMatchObject({ type: 'deposit', amountMillicredits: 50_000, reference: 'wire-77' });
		expect(
			(await credit(admin, 'credits', { amountMillicredits: 50_000, reference: 'wire-77', note: 'again' })).json.duplicate,
		).toBe(true);
		expect((await credit(admin, 'credits', { amountMillicredits: 1, reference: 'wire-77', note: 'other' })).status).toBe(409);
		expect(
			(await credit(admin, 'adjustments', { amountMillicredits: -1000, reference: 'promo-fix', note: 'correction' })).status,
		).toBe(201);
		expect(
			(await credit(admin, 'refunds', { amountMillicredits: 10_000_000, reference: 'rf-1', note: 'too much' })).status,
		).toBe(409);
		expect(
			(await credit(admin, 'refunds', { amountMillicredits: 1000, reference: 'rf-1', note: 'returned' })).json.entry
				.amountMillicredits,
		).toBe(-1000);
		const audit = await h.portal.shared.audit.list({ merchantId: M1 });
		expect(audit.map((a) => a.action)).toEqual(
			expect.arrayContaining(['credits.added', 'credits.adjusted', 'credits.refunded']),
		);

		// Support sees receipts and charges (view); Finance too
		expect((await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2`, { headers: support })).status).toBe(200);
		const finance = await h.login({ kind: 'admin', subject: 'adm_finance' });
		expect((await credit(finance, 'credits', { amountMillicredits: 5, reference: 'fin-1', note: 'n' })).status).toBe(201);
		const first = await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2`, { headers: finance });
		expect(first.json.items.map((/** @type {any} */ e) => e.seq)).toEqual([1, 2]);
		const next = await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2&cursor=${first.json.nextCursor}`, {
			headers: finance,
		});
		expect(next.json.items.map((/** @type {any} */ e) => e.seq)).toEqual([3, 4]);
		expect((await h.call('GET', `/v1/admin/merchants/${M1}/ledger/verification`, { headers: finance })).json).toMatchObject({
			ok: true,
		});
		// no on-demand settlement or reconciliation routes: settlement happens on read
		expect((await h.call('POST', '/v1/admin/commerce/reconciliation', { headers: { ...admin, ...idem() } })).status).toBe(404);
		expect((await h.call('GET', '/v1/admin/commerce/alerts', { headers: finance })).json.items).toEqual([]);
		expect((await h.call('POST', '/v1/admin/commerce/settlement', { headers: { ...finance, ...idem() } })).status).toBe(404);

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
		const usage = await h.call('POST', '/v1/product/usage', {
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
		expect(usage.json.results).toEqual([{ idempotencyKey: 'x1', status: 'rejected', reason: 'subscription_mismatch' }]);
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
