/**
 * SR-7-2: hard cost ceilings in code. One address or number gets at most so many messages an hour and a day, whatever
 * the merchant's send limits say and required messages included (Accounts' sign-in codes have their own higher
 * ceiling), and a website sends at most so many texts and WhatsApp messages a minute. Over a ceiling the send is refused
 * with the problem `rate_limited` and the refusal is logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_CEILINGS, CHANNEL_MINUTE_CEILINGS, RECIPIENT_CEILINGS } from '../core/limits.js';
import { ADMIN_ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const ALL = ['email', 'sms', 'whatsapp', 'browser_push', 'staff_push', 'fallback', 'send_limits', 'send_api'];
const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555' };
const MIN = 60_000;
const HOUR = 60 * MIN;
const TWILIO_ORIGIN = 'https://api.twilio.com';
const RESEND_ORIGIN = 'https://api.resend.com';

let filled = 0;
/**
 * Put messages in the delivery log as if they had been sent `age` ms ago.
 * @param {{ channel: string, address: string | ((i: number) => string), count: number, age: number, status?: string }} input
 */
const fill = async ({ channel, address, count, age, status = 'sent' }) => {
	const messages = await env.merchantCollection('messages');
	await messages.insertMany(
		Array.from({ length: count }, (_, i) => {
			filled += 1;
			return {
				websiteId: env.websiteId,
				id: `msg_filler_${filled}`,
				template: 'receipt',
				channel,
				address: typeof address === 'function' ? address(i) : address,
				status,
				createdAt: new Date(env.now() - age),
				sentAt: status === 'sent' ? new Date(env.now() - age) : null,
			};
		}),
	);
};
const clearFiller = async () =>
	(await env.merchantCollection('messages')).deleteMany({ websiteId: env.websiteId, id: /^msg_filler_/ });
/** The providers' calls so far. @param {string} origin */
const callsTo = (origin) => env.providers.callsTo(origin).length;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
	await env.connect('email', RESEND);
	await env.connect('sms', TWILIO);
	await env.connect('whatsapp', META);
	await env.template({ key: 'receipt', channel: 'email', subject: 'Receipt', text: 'Paid', required: true, urgent: true });
	await env.template({ key: 'receipt', channel: 'sms', text: 'Paid', required: true, urgent: true });
	await env.template({ key: 'receipt', channel: 'whatsapp', text: 'Paid', required: true, urgent: true });
	await env.template({ key: 'accounts.code', channel: 'email', subject: 'Code', text: 'Code {code}' });
	await env.template({ key: 'accounts.code', channel: 'sms', text: 'Code {code}' });
});
afterAll(async () => {
	await env.product.close();
});

describe('ceilings per recipient (SR-7-2)', () => {
	it('refuse a required email once the address got its hourly ceiling, log it, and let the window slide', async () => {
		const to = { email: 'hour@example.com' };
		await fill({ channel: 'email', address: to.email, count: RECIPIENT_CEILINGS.email.perHour, age: 10 * MIN });
		const before = callsTo(RESEND_ORIGIN);
		env.logs.length = 0;
		const refused = await env.send('email', { template: 'receipt', to });
		expect(refused.status).toBe(429);
		expect(refused.json.type).toMatch(/rate_limited$/);
		expect(refused.json.detail).toBe(
			`Too many email messages to this recipient: at most ${RECIPIENT_CEILINGS.email.perHour} an hour.`,
		);
		expect(refused.json.errors[0]).toMatchObject({ path: '/to', code: 'recipient_limit' });
		expect(callsTo(RESEND_ORIGIN)).toBe(before);
		const warned = env.logs.filter((entry) => entry.level === 'warn');
		expect(warned).toEqual([
			expect.objectContaining({
				message: 'message refused: the recipient ceiling is reached',
				fields: expect.objectContaining({ websiteId: env.websiteId, channel: 'email', window: 'hour' }),
			}),
		]);
		expect(JSON.stringify(warned)).not.toContain('hour@example.com');
		// another address is not affected
		expect((await env.send('email', { template: 'receipt', to: { email: 'other@example.com' } })).json.status).toBe('sent');
		// an hour later the address may get a message again
		env.advance(HOUR);
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
	});

	it('refuse once the address got its daily ceiling', async () => {
		const to = { email: 'day@example.com' };
		await fill({ channel: 'email', address: to.email, count: RECIPIENT_CEILINGS.email.perDay, age: 5 * HOUR });
		const refused = await env.send('email', { template: 'receipt', to });
		expect(refused.status).toBe(429);
		expect(refused.json.detail).toBe(
			`Too many email messages to this recipient: at most ${RECIPIENT_CEILINGS.email.perDay} a day.`,
		);
		expect(refused.json.errors[0]).toMatchObject({ code: 'recipient_limit' });
	});

	it('do not count skipped messages, and count the ceiling of the channel, not the other channels', async () => {
		const to = { email: 'skipped@example.com', phone: '+15550100001' };
		await fill({
			channel: 'email',
			address: to.email,
			count: RECIPIENT_CEILINGS.email.perHour,
			age: 5 * MIN,
			status: 'skipped',
		});
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
		await fill({ channel: 'sms', address: to.phone, count: RECIPIENT_CEILINGS.sms.perHour, age: 5 * MIN });
		expect((await env.send('sms', { template: 'receipt', to })).status).toBe(429);
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
	});

	it('give Accounts’ sign-in codes their own higher ceiling', async () => {
		const to = { email: 'codes@example.com' };
		await fill({ channel: 'email', address: to.email, count: RECIPIENT_CEILINGS.email.perHour, age: 5 * MIN });
		expect((await env.send('email', { template: 'receipt', to })).status).toBe(429);
		expect((await env.send('email', { template: 'accounts.code', to, values: { code: '123456' } })).json.status).toBe('sent');
		await fill({
			channel: 'email',
			address: to.email,
			count: ACCOUNT_CEILINGS.email.perHour - RECIPIENT_CEILINGS.email.perHour,
			age: 5 * MIN,
		});
		const refused = await env.send('email', { template: 'accounts.code', to, values: { code: '123456' } });
		expect(refused.status).toBe(429);
		expect(refused.json.detail).toBe(
			`Too many email messages to this recipient: at most ${ACCOUNT_CEILINGS.email.perHour} an hour.`,
		);
	});

	it('hold for a message the merchant’s staff write, too', async () => {
		const to = 'staff-sent@example.com';
		await fill({ channel: 'email', address: to, count: RECIPIENT_CEILINGS.email.perHour, age: 5 * MIN });
		const sent = await env.call('POST', '/v1/admin/messages', {
			token: await env.ticket(),
			origin: ADMIN_ORIGIN,
			body: { channel: 'email', to, subject: 'Hello', text: 'Hello there', kind: 'transactional' },
		});
		expect(sent.status).toBe(429);
		expect((await sent.json()).errors[0]).toMatchObject({ code: 'recipient_limit' });
	});

	it('hold when a message falls back to a channel whose address is at its ceiling', async () => {
		const to = { phone: '+15550100077', email: 'fallback@example.com' };
		await env.call('PUT', '/v1/lists/fallback_chains', {
			token: env.server,
			body: { value: [{ channel: 'email', then: ['sms'] }] },
		});
		env.providers.respond(RESEND_ORIGIN, () => ({ status: 400, body: '{"message":"no"}' }));
		await fill({ channel: 'sms', address: to.phone, count: RECIPIENT_CEILINGS.sms.perHour, age: 5 * MIN });
		const before = callsTo(TWILIO_ORIGIN);
		env.logs.length = 0;
		const sent = await env.send('email', { template: 'receipt', to });
		expect(sent.json.status).toBe('failed');
		expect(callsTo(TWILIO_ORIGIN)).toBe(before);
		expect(env.logs).toContainEqual(
			expect.objectContaining({
				level: 'warn',
				message: 'message refused: the recipient ceiling is reached',
				fields: expect.objectContaining({ channel: 'sms', window: 'hour' }),
			}),
		);
		env.providers.reset(RESEND_ORIGIN);
		await env.call('PUT', '/v1/lists/fallback_chains', { token: env.server, body: { value: [] } });
	});

	it('are counted with an index on website, address and creation time', async () => {
		expect(await env.merchantIndexes('messages')).toContainEqual(
			expect.objectContaining({ name: 'by_address_created', key: { websiteId: 1, address: 1, createdAt: -1 } }),
		);
	});

	afterAll(clearFiller);
});

describe('ceilings per minute for texts and WhatsApp (SR-7-2)', () => {
	it('refuse an SMS once the website sent its ceiling in the last minute, for every number', async () => {
		await clearFiller();
		await fill({
			channel: 'sms',
			address: (i) => `+1555020${String(i).padStart(4, '0')}`,
			count: CHANNEL_MINUTE_CEILINGS.sms,
			age: 20_000,
		});
		const before = callsTo(TWILIO_ORIGIN);
		env.logs.length = 0;
		const refused = await env.send('sms', { template: 'receipt', to: { phone: '+15550309999' } });
		expect(refused.status).toBe(429);
		expect(refused.json.type).toMatch(/rate_limited$/);
		expect(refused.json.detail).toBe(`Too many sms messages in a minute: at most ${CHANNEL_MINUTE_CEILINGS.sms} a minute.`);
		expect(refused.json.errors[0]).toMatchObject({ path: '/to', code: 'channel_limit' });
		expect(callsTo(TWILIO_ORIGIN)).toBe(before);
		expect(env.logs).toContainEqual(
			expect.objectContaining({
				level: 'warn',
				message: 'message refused: the channel ceiling is reached',
				fields: expect.objectContaining({ websiteId: env.websiteId, channel: 'sms', limit: CHANNEL_MINUTE_CEILINGS.sms }),
			}),
		);
		// email is another channel; WhatsApp has its own count
		expect((await env.send('email', { template: 'receipt', to: { email: 'minute@example.com' } })).json.status).toBe('sent');
		expect((await env.send('whatsapp', { template: 'receipt', to: { phone: '+15550309998' } })).json.status).toBe('sent');
		// a minute later it goes again
		env.advance(MIN);
		expect((await env.send('sms', { template: 'receipt', to: { phone: '+15550309999' } })).json.status).toBe('sent');
	});

	it('refuse WhatsApp messages the same way', async () => {
		await clearFiller();
		await fill({ channel: 'whatsapp', address: '+15550400000', count: CHANNEL_MINUTE_CEILINGS.whatsapp, age: 10_000 });
		const refused = await env.send('whatsapp', { template: 'receipt', to: { phone: '+15550309997' } });
		expect(refused.status).toBe(429);
		expect(refused.json.errors[0]).toMatchObject({ code: 'channel_limit' });
	});

	it('keep the ceilings lower than the 600 a minute every send route allows', () => {
		expect(CHANNEL_MINUTE_CEILINGS.sms).toBeLessThan(600);
		expect(CHANNEL_MINUTE_CEILINGS.whatsapp).toBeLessThan(600);
	});
});
