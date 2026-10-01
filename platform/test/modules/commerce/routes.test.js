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
	it('enforces merchant, website-grant, staff and product boundaries on every route', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_routes', clock });
		await h.credit(M1, 100_000);
		await h.credit(M2, 100_000);
		const owner1 = await h.login({ kind: 'merchant', subject: 'usr_o1', merchantId: M1, roles: ['owner'] });
		const owner2 = await h.login({ kind: 'merchant', subject: 'usr_o2', merchantId: M2, roles: ['owner'] });
		const billing1 = await h.login({ kind: 'merchant', subject: 'usr_b1', merchantId: M1, roles: ['billing'] });
		const editorW2 = await h.login({
			kind: 'merchant',
			subject: 'usr_e1',
			merchantId: M1,
			roles: [],
			grants: [{ websiteId: W2, roles: ['editor'] }],
		});
		let admin = await h.login({ kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
		const staffLogin = () => h.login({ kind: 'staff', subject: 'stf_support', roles: ['support'], mfa: true });

		// subscribe
		const created = await h.call('POST', `/v1/merchants/${M1}/websites/${W1}/subscriptions`, {
			headers: { ...owner1, ...idem() },
			body: { appId: APP, planCode: 'starter' },
		});
		expect(created.status).toBe(201);
		const sub1 = created.json.subscription.subscriptionId;
		const other = await h.call('POST', `/v1/merchants/${M2}/websites/${W3}/subscriptions`, {
			headers: { ...owner2, ...idem() },
			body: { appId: APP },
		});
		expect(other.status).toBe(201);
		const sub3 = other.json.subscription.subscriptionId;
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W3}/subscriptions`, {
					headers: { ...owner1, ...idem() },
					body: { appId: APP2 },
				})
			).status,
		).toBe(404);
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W2}/subscriptions`, {
					headers: { ...owner1, ...idem() },
					body: { appId: 'nope' },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W2}/subscriptions`, {
					headers: { ...editorW2, ...idem() },
					body: { appId: APP2 },
				})
			).status,
		).toBe(403);
		expect(
			(
				await h.call('POST', `/v1/merchants/${M1}/websites/${W2}/subscriptions`, {
					headers: { ...billing1, ...idem() },
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
			['GET', `/v1/merchants/${M1}/spend-policies`, undefined],
			['POST', `/v1/merchants/${M1}/spend-policies`, { scope: 'merchant', window: 'day', limit: 1 }],
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
		expect((await h.call('PUT', `${base1}/elements/reports`, { headers: owner1, body: { enabled: true } })).status).toBe(200);
		expect((await h.call('PUT', `${base1}/elements/reports`, { headers: owner1, body: { enabled: 'yes' } })).status).toBe(422);
		expect((await h.call('PUT', `${base1}/elements/ai_copy`, { headers: owner1, body: { enabled: true } })).status).toBe(403);
		expect((await h.call('PUT', `${base1}/elements/ai_copy`, { headers: admin, body: { enabled: true } })).status).toBe(200);
		expect((await h.call('PUT', `${base1}/plan`, { headers: owner1, body: {} })).status).toBe(422);
		expect(
			(await h.call('PUT', `${base1}/plan`, { headers: owner1, body: { planCode: 'pro' } })).json.subscription.planCode,
		).toBe('pro');
		expect(
			(await h.call('POST', `${base1}/pause`, { headers: { ...owner1, ...idem() }, body: { reason: 'Bad Reason' } })).status,
		).toBe(422);
		expect(
			(await h.call('POST', `${base1}/pause`, { headers: { ...owner1, ...idem() }, body: { reason: 'holiday' } })).json
				.subscription.status,
		).toBe('paused');
		expect((await h.call('POST', `${base1}/resume`, { headers: { ...owner1, ...idem() } })).json.subscription.status).toBe(
			'active',
		);

		// website-scoped grants see only their website
		expect((await h.call('GET', base1, { headers: editorW2 })).status).toBe(403);
		expect((await h.call('GET', `/v1/merchants/${M1}/subscriptions`, { headers: editorW2 })).status).toBe(403);
		const scoped = await h.call('GET', `/v1/merchants/${M1}/subscriptions?websiteId=${W2}`, { headers: editorW2 });
		expect(scoped.json.items.map((/** @type {any} */ s) => s.websiteId)).toEqual([W2]);
		expect((await h.call('GET', `/v1/merchants/${M1}/balance`, { headers: editorW2 })).status).toBe(403);

		// money views
		clock.set(T0 + 2 * HOUR + 5 * 60_000); // staff sessions idle out after 30 min: sign in again
		admin = await h.login({ kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
		const support = await staffLogin();
		const forced = await h.call('POST', '/v1/admin/commerce/settlement', {
			headers: { ...admin, ...idem() },
			body: { merchantId: M1 },
		});
		expect([forced.status, forced.json]).toMatchObject([200, { stats: { merchants: 1 } }]);
		const balance = await h.call('GET', `/v1/merchants/${M1}/balance`, { headers: billing1 });
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

		// spend policies
		const policy = await h.call('POST', `/v1/merchants/${M1}/spend-policies`, {
			headers: { ...billing1, ...idem() },
			body: { scope: 'website', websiteId: W2, window: 'month', limit: 1_000_000 },
		});
		expect(policy.status).toBe(201);
		const policyPath = `/v1/merchants/${M1}/spend-policies/${policy.json.policy.policyId}`;
		expect((await h.call('PUT', policyPath, { headers: owner2, body: { limit: 5 } })).status).toBe(403);
		expect((await h.call('PUT', policyPath, { headers: billing1, body: { limit: 5 } })).json.policy.limitMillicredits).toBe(5);
		expect((await h.call('GET', `/v1/merchants/${M1}/spend-policies`, { headers: owner1 })).json.items).toHaveLength(1);
		expect((await h.call('DELETE', policyPath, { headers: owner2 })).status).toBe(403);
		expect((await h.call('DELETE', policyPath, { headers: billing1 })).status).toBe(204);

		// admin: staff only, permission checked
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

		const page1 = await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2`, { headers: support });
		expect(page1.status).toBe(403); // support lacks platform.finance.read
		const finance = await h.login({ kind: 'staff', subject: 'stf_fin', roles: ['finance'], mfa: true });
		const first = await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2`, { headers: finance });
		expect(first.json.items.map((/** @type {any} */ e) => e.seq)).toEqual([1, 2]);
		const next = await h.call('GET', `/v1/admin/merchants/${M1}/ledger?limit=2&cursor=${first.json.nextCursor}`, {
			headers: finance,
		});
		expect(next.json.items.map((/** @type {any} */ e) => e.seq)).toEqual([3, 4]);
		expect((await h.call('GET', `/v1/admin/merchants/${M1}/ledger/verification`, { headers: finance })).json).toMatchObject({
			ok: true,
		});
		const recon = await h.call('POST', '/v1/admin/commerce/reconciliation', { headers: { ...admin, ...idem() } });
		expect(recon.json.stats).toMatchObject({ complete: true, discrepancies: 0 });
		expect((await h.call('GET', '/v1/admin/commerce/reconciliation', { headers: finance })).json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/admin/commerce/alerts', { headers: finance })).json.items).toEqual([]);
		expect((await h.call('POST', '/v1/admin/commerce/settlement', { headers: { ...finance, ...idem() } })).status).toBe(403);

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
			(await h.call('POST', `${base1}/cancel`, { headers: { ...owner1, ...idem() }, body: { reason: 'done' } })).json
				.subscription.status,
		).toBe('cancelled');
		expect((await h.call('GET', `/v1/product/entitlements?websiteId=${W1}`, { headers: await app1() })).status).toBe(410);
		expect(STAFF.type).toBe('staff');
	});
});
