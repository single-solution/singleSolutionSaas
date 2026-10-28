/**
 * SR-7-1: browser push subscriptions of visitors have a ceiling per website, expire when not seen for a long time (a
 * new subscribe and a push the browser accepted refresh the time), and are found by an index; the merchant's staff keep
 * theirs without any ceiling or expiry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_VISITOR_SUBSCRIPTIONS, VISITOR_SUBSCRIPTION_DAYS } from '../core/limits.js';
import { ADMIN_ORIGIN, ORIGIN, PUSH_ORIGIN, browserSubscription, pushKeys, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;
const DAY = 86_400_000;

/** A visitor subscribes. @param {ReturnType<typeof browserSubscription>} browser */
const subscribe = (browser) =>
	env.call('POST', '/v1/push/subscriptions', {
		token: env.browser,
		origin: ORIGIN,
		body: { subscription: browser.subscription },
	});
/** A staff member subscribes (a ticket with the permission). @param {ReturnType<typeof browserSubscription>} browser */
const subscribeStaff = async (browser) =>
	env.call('POST', '/v1/admin/push/subscriptions', {
		token: await env.ticket(),
		origin: ADMIN_ORIGIN,
		body: { subscription: browser.subscription },
	});
/** A stored subscription, by endpoint. @param {string} endpoint */
const stored = async (endpoint) =>
	(await env.merchantCollection('subscriptions')).findOne({ websiteId: env.websiteId, endpoint });
/** Fill the website's visitor subscriptions up to `count`. @param {number} count */
const fill = async (count) => {
	const collection = await env.merchantCollection('subscriptions');
	const have = await collection.countDocuments({ websiteId: env.websiteId, kind: 'visitor' });
	await collection.insertMany(
		Array.from({ length: count - have }, (_, i) => ({
			websiteId: env.websiteId,
			id: `sub_filler_${i}`,
			kind: 'visitor',
			staffId: null,
			endpoint: `https://filler.example/push/${i}`,
			keys: { p256dh: 'x', auth: 'y' },
			seenAt: new Date(env.now()),
		})),
	);
};
const clearFiller = async () =>
	(await env.merchantCollection('subscriptions')).deleteMany({
		websiteId: env.websiteId,
		endpoint: /^https:\/\/filler\.example\//,
	});

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['push', 'browser_push', 'staff_push', 'send_api']);
	await env.connectDatabase();
	await env.connect('push_keys', pushKeys());
	await env.template({ key: 'alert', channel: 'push', subject: 'Back in stock', text: '{item} is back' });
});
afterAll(async () => {
	await env.product.close();
});

describe('visitor push subscriptions (SR-7-1)', () => {
	it('are looked up by an index on website and endpoint, and expire by a last-seen time', async () => {
		expect((await subscribe(browserSubscription(`${PUSH_ORIGIN}/push/first`))).status).toBe(201);
		const indexes = await env.merchantIndexes('subscriptions');
		expect(indexes).toContainEqual(
			expect.objectContaining({ name: 'by_endpoint', key: { websiteId: 1, endpoint: 1 }, unique: true }),
		);
		expect(indexes).toContainEqual(
			expect.objectContaining({ name: 'expire', key: { seenAt: 1 }, expireAfterSeconds: VISITOR_SUBSCRIPTION_DAYS * 86_400 }),
		);
	});

	it('refuse a new subscription once the website holds MAX_VISITOR_SUBSCRIPTIONS; a known browser still works', async () => {
		const known = browserSubscription(`${PUSH_ORIGIN}/push/known`);
		const knownId = (await (await subscribe(known)).json()).subscriberId;
		await fill(MAX_VISITOR_SUBSCRIPTIONS);
		try {
			env.logs.length = 0;
			const refused = await subscribe(browserSubscription(`${PUSH_ORIGIN}/push/one-more`));
			expect(refused.status).toBe(422);
			const body = await refused.json();
			expect(body.errors[0]).toMatchObject({ path: '/subscription', code: 'limit_reached' });
			expect(body.detail).toBe(
				`This website has reached its limit of ${MAX_VISITOR_SUBSCRIPTIONS} browser push subscriptions.`,
			);
			expect(await stored(`${PUSH_ORIGIN}/push/one-more`)).toBeNull();
			expect(env.logs).toContainEqual(
				expect.objectContaining({
					level: 'warn',
					message: 'browser push subscription refused: the website holds the most it may',
					fields: expect.objectContaining({ websiteId: env.websiteId, limit: MAX_VISITOR_SUBSCRIPTIONS }),
				}),
			);
			// a browser that is already subscribed keeps its id and may subscribe again
			const again = await subscribe(known);
			expect(again.status).toBe(201);
			expect((await again.json()).subscriberId).toBe(knownId);
			// the merchant's staff are not counted and not refused
			expect((await subscribeStaff(browserSubscription(`${PUSH_ORIGIN}/push/staff-full`))).status).toBe(201);
		} finally {
			await clearFiller();
		}
		expect((await subscribe(browserSubscription(`${PUSH_ORIGIN}/push/after`))).status).toBe(201);
	});

	it('keep a last-seen time that a new subscribe and an accepted push refresh; staff subscriptions have none', async () => {
		const visitor = browserSubscription(`${PUSH_ORIGIN}/push/seen`);
		const first = await (await subscribe(visitor)).json();
		expect((await stored(visitor.subscription.endpoint))?.seenAt).toEqual(new Date(env.now()));
		env.advance(30 * DAY);
		await subscribe(visitor);
		expect((await stored(visitor.subscription.endpoint))?.seenAt).toEqual(new Date(env.now()));
		env.advance(30 * DAY);
		const pushed = await env.send('push', {
			template: 'alert',
			to: { subscriberId: first.subscriberId },
			values: { item: 'Phone' },
		});
		expect(pushed.json.status).toBe('sent');
		expect((await stored(visitor.subscription.endpoint))?.seenAt).toEqual(new Date(env.now()));
		// a push the browser did not accept does not refresh it
		env.advance(DAY);
		env.providers.respond(PUSH_ORIGIN, () => ({ status: 500 }));
		await env.send('push', { template: 'alert', to: { subscriberId: first.subscriberId }, values: { item: 'Phone' } });
		env.providers.reset(PUSH_ORIGIN);
		expect((await stored(visitor.subscription.endpoint))?.seenAt).toEqual(new Date(env.now() - DAY));

		const staff = browserSubscription(`${PUSH_ORIGIN}/push/staff-seen`);
		expect((await subscribeStaff(staff)).status).toBe(201);
		expect(await stored(staff.subscription.endpoint)).not.toHaveProperty('seenAt');
		// a browser that was a visitor's and is now a staff member's never expires
		expect((await subscribeStaff(visitor)).status).toBe(201);
		expect(await stored(visitor.subscription.endpoint)).toMatchObject({ kind: 'staff' });
		expect(await stored(visitor.subscription.endpoint)).not.toHaveProperty('seenAt');
	});

	it('allows both visitor and staff push when only push is on, and honors audience toggles', async () => {
		await env.switchOn(['push', 'send_api']);
		const visitor = browserSubscription(`${PUSH_ORIGIN}/push/unified-visitor`);
		const subRes = await subscribe(visitor);
		expect(subRes.status).toBe(201);
		const { subscriberId } = await subRes.json();

		const staff = browserSubscription(`${PUSH_ORIGIN}/push/unified-staff`);
		const staffSubRes = await subscribeStaff(staff);
		expect(staffSubRes.status).toBe(201);

		// Default: visitors and staff audience both allowed
		const sentVisitor = await env.send('push', {
			template: 'alert',
			to: { subscriberId },
			values: { item: 'Tablet' },
		});
		expect(sentVisitor.json.status).toBe('sent');

		// Audience toggle: visitors: false refuses visitor push
		await env.setting('push', 'visitors', false);
		const sentVisitorRefused = await env.send('push', {
			template: 'alert',
			to: { subscriberId },
			values: { item: 'Tablet' },
		});
		expect(sentVisitorRefused.json.status).toBe('failed');
		expect(sentVisitorRefused.json.reason).toBe('feature_off');

		// Audience toggle: staff: false refuses staff push
		await env.template({ key: 'staff_alert', channel: 'staff_push', subject: 'Staff Alert', text: 'Note' });
		await env.setting('push', 'staff', false);
		const sentStaffRefused = await env.send('staff-push', {
			template: 'staff_alert',
			to: { staffId: 'usr_test_staff' },
		});
		expect(sentStaffRefused.json.status).toBe('failed');
		expect(sentStaffRefused.json.reason).toBe('feature_off');

		// Restore settings and switches
		await env.setting('push', 'visitors', true);
		await env.setting('push', 'staff', true);
		await env.switchOn(['push', 'browser_push', 'staff_push', 'send_api']);
	});
});
