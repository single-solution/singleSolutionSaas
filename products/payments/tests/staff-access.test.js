/**
 * Payments' staff routes: money is moved and payment links are made by a staff member's verified sign-in; the
 * server token alone changes no setting and refunds nothing (SEC). Taking a payment is the website's runtime.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['payment_api', 'refunds', 'manual_payments', 'payment_links', 'subscriptions']);
	await env.connectDatabase();
});

/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

describe('Payments with the server token alone', () => {
	it('refunds, confirms, makes links, changes settings: refused 403 needs_signed_in_staff', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['POST', '/v1/payments/pay_none/refunds', { amount: 100 }],
			['POST', '/v1/payments/pay_none/confirm', {}],
			['GET', '/v1/payments/pay_none/proof', undefined],
			['POST', '/v1/links', { title: 'x', currency: 'USD', amount: 100, gateways: ['bank_transfer'] }],
			['PATCH', '/v1/links/lnk_none', { title: 'y' }],
			['POST', '/v1/subscriptions/sub_none/cancel', {}],
			['GET', '/v1/payments', undefined],
			['GET', '/v1/payments/count', undefined],
			['GET', '/v1/events', undefined],
			['PUT', '/v1/settings/payment_api.checkoutExpiryHours', { value: 6 }],
			['PUT', '/v1/connections/stripe', { value: { secretKey: 'sk_x' } }],
			['PUT', '/v1/lists/manual_methods', { value: [] }],
		])) {
			const refused = await env.call(method, path, { token: env.server, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status, typeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});

	it('still serves checkout: the manual methods are listed', async () => {
		const methods = await env.call('GET', '/v1/manual-methods', { token: env.server, bare: true });
		expect(methods.status).toBe(200);
	});
});

describe('every connection of the product (database, storage, provider keys, pasted product tokens)', () => {
	it('cannot be saved, removed or test-called with the server token alone: 403, and the list stays as it was', async () => {
		const listed = await env.call('GET', '/v1/connections', { token: env.server });
		const names = listed.json.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toContain('database');
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: 'attacker-value' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await env.call(method, path, {
					token: env.server,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([name, method, refused.status, String(refused.json?.type).split('/').pop()]).toEqual([
					name,
					method,
					403,
					'needs_signed_in_staff',
				]);
			}
		}
		const after = await env.call('GET', '/v1/connections', { token: env.server });
		expect(after.json.connections).toEqual(listed.json.connections);
	});
});

describe('a staff sign-in', () => {
	it('without payments.refund cannot refund; with it the refund is theirs', async () => {
		for (const permissions of [[], ['payments:payments.read'], ['payments:payments.confirm']]) {
			const refused = await env.call('POST', '/v1/payments/pay_none/refunds', {
				token: env.server,
				staff: { permissions },
				body: { amount: 100 },
			});
			expect([refused.status, typeOf(refused)]).toEqual([403, 'forbidden']);
		}
		// with the permission the gate lets the call through (the payment itself does not exist)
		const allowed = await env.call('POST', '/v1/payments/pay_none/refunds', {
			token: env.server,
			staff: { permissions: ['payments:payments.refund'] },
			body: { amount: 100 },
		});
		expect(allowed.status).toBe(404);
	});

	it('of another website is refused 401 invalid_sign_in', async () => {
		await env.staffHeaders();
		const other = await env.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const refused = await env.call('POST', '/v1/payments/pay_none/refunds', {
			token: env.server,
			bare: true,
			headers: { 'ss-sign-in': other },
			body: { amount: 100 },
		});
		expect([refused.status, typeOf(refused)]).toEqual([401, 'invalid_sign_in']);
	});
});
