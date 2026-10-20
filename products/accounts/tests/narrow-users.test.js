/**
 * SR-4-2: the narrow user lookups other products make with the server token alone (who holds a permission, one address,
 * one phone, a search of 6 or more characters, one user by id) answer a small view and never page through the customer
 * base. `email` is an exact filter; a narrow search gives at most 10 users and no cursor; the notes, tags, blocked reason,
 * lock times, recovery codes and consents stay with the signed-in staff member who holds `users.read`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** What a product reads of a user (Chat's and the alerts' staff lists, Ecommerce's member check and user lookup). */
const NARROW_KEYS = ['blocked', 'createdAt', 'email', 'hasPassword', 'id', 'name', 'phone'];

/** The server token alone: how another product asks. @param {string} path */
const narrow = (path) => env.call('GET', path, { token: env.server, bare: true });
/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @type {string[]} */
const ids = [];

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	for (let n = 1; n <= 14; n += 1) {
		const made = await env.serverCall('POST', '/v1/users', {
			name: `Sample Buyer ${n}`,
			email: `buyer${n}@example.com`,
			password: 'correct horse battery',
			notes: 'pays late, ask the manager',
			tags: ['VIP'],
		});
		expect(made.status).toBe(201);
		ids.push(made.json.id);
	}
	// one of them is blocked, with a reason only staff see
	expect((await env.serverCall('PATCH', `/v1/users/${ids[0]}`, { blocked: true, blockedReason: 'chargebacks' })).status).toBe(
		200,
	);
});
afterAll(async () => {
	await env.product.close();
});

describe('email is an exact filter', () => {
	it('answers the one user of that address, whatever the limit, and nobody for an unknown address', async () => {
		const one = await narrow('/v1/users?email=BUYER5%40example.com&limit=100');
		expect(one.status).toBe(200);
		expect(one.json.items.map((/** @type {any} */ u) => u.email)).toEqual(['buyer5@example.com']);
		expect(one.json).toMatchObject({ nextCursor: null, hasMore: false });
		const none = await narrow('/v1/users?email=nobody%40example.com&limit=100');
		expect(none.json).toMatchObject({ items: [], nextCursor: null, hasMore: false });
		// a staff member's list is filtered the same way
		const staff = await env.serverCall('GET', '/v1/users?email=buyer6%40example.com&limit=100');
		expect(staff.json.items.map((/** @type {any} */ u) => u.email)).toEqual(['buyer6@example.com']);
		expect(typeOf(await narrow('/v1/users?email=not-an-address'))).toBe('validation_failed');
	});
});

describe('a narrow call gets at most 10 users, no cursor and a small view', () => {
	it('a search of 6 characters or more: 10 users at most, the cursor is ignored, nothing to page through', async () => {
		const first = await narrow('/v1/users?q=Sample%20Buyer&limit=10');
		expect(first.status).toBe(200);
		expect(first.json.items).toHaveLength(10);
		expect(first.json).toMatchObject({ nextCursor: null, hasMore: false });
		const again = await narrow(`/v1/users?q=Sample%20Buyer&limit=10&cursor=${encodeURIComponent('eyJrIjpbIjIwMjAiLCJ4Il19')}`);
		expect(again.json.items.map((/** @type {any} */ u) => u.id)).toEqual(first.json.items.map((/** @type {any} */ u) => u.id));
		// asking for more than 10 is not narrow: the signed-in staff member's
		expect(typeOf(await narrow('/v1/users?q=Sample%20Buyer&limit=100'))).toBe('needs_signed_in_staff');
	});

	it('every row is the small view: no notes, tags, blocked reason, lock times, recovery codes or consents', async () => {
		for (const path of [
			'/v1/users?q=Sample%20Buyer&limit=10',
			'/v1/users?email=buyer1%40example.com',
			'/v1/users?permission=site%3Avip.view',
		]) {
			const answer = await narrow(path);
			expect(answer.status).toBe(200);
			for (const user of answer.json.items) expect(Object.keys(user).sort()).toEqual(NARROW_KEYS);
		}
		const blocked = (await narrow('/v1/users?email=buyer1%40example.com')).json.items[0];
		expect(blocked).toMatchObject({ id: ids[0], name: 'Sample Buyer 1', blocked: true, hasPassword: true });
		const open = (await narrow('/v1/users?email=buyer2%40example.com')).json.items[0];
		expect(open).toMatchObject({ blocked: false, phone: null, email: 'buyer2@example.com' });
		expect(Date.parse(open.createdAt)).toBeGreaterThan(0);
	});

	it('who holds a permission: staff only, in pages as before (the alerts and Chat read them), in the small view', async () => {
		const staff = await narrow('/v1/users?permission=chat%3Ainbox.reply&blocked=false&limit=100');
		expect(staff.status).toBe(200);
		expect(staff.json.items.length).toBeGreaterThan(0);
		for (const user of staff.json.items) expect(Object.keys(user).sort()).toEqual(NARROW_KEYS);
		expect(staff.json.items.map((/** @type {any} */ u) => u.email)).toContain('staff@shop.example.com');
	});

	it('one user by id with the server token alone is the small view; the signed-in staff member sees all of it', async () => {
		const small = await narrow(`/v1/users/${ids[0]}`);
		expect(small.status).toBe(200);
		expect(Object.keys(small.json).sort()).toEqual(NARROW_KEYS);
		expect(small.json).toMatchObject({ id: ids[0], blocked: true });
		expect(typeOf(await narrow('/v1/users/usr_none'))).toBe('not_found');
		const full = await env.serverCall('GET', `/v1/users/${ids[0]}`);
		expect(full.json).toMatchObject({
			notes: 'pays late, ask the manager',
			tags: ['VIP'],
			blocked: { reason: 'chargebacks' },
			status: 'active',
		});
		expect(full.json).toHaveProperty('lockedUntil');
		expect(full.json).toHaveProperty('recoveryCodesLeft');
		// the staff member's list stays the full view
		const listed = await env.serverCall('GET', '/v1/users?email=buyer3%40example.com');
		expect(listed.json.items[0]).toMatchObject({ notes: 'pays late, ask the manager', tags: ['VIP'] });
	});
});
