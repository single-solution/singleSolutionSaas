/**
 * The links of a message (SR-7-3): a value a product names in `linkValues` goes into a message only as an https
 * address on the website's own hosts; plain text stays plain.
 */
import { portalSectionsOf } from '@ss/app-kit/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { isOwnLink } from '../core/links.js';
import { ORIGIN, setup } from './helpers.js';

const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };

/** What Chat's kit attaches to a reply alert: its default words, with a `{link}`. */
const ALERT = {
	template: 'chat.staff_reply',
	to: { email: 'ana@example.com' },
	defaults: {
		email: {
			subject: '{staff} replied',
			text: 'Hi {name}, {staff} replied: {preview}\n{link}',
			required: false,
			urgent: false,
			sensitive: false,
		},
	},
};

describe('isOwnLink', () => {
	const hosts = ['shop.example.com', 'WWW.Shop.Example.com.'];
	it('takes nothing, or an https address on an own host', () => {
		expect(isOwnLink('', hosts)).toBe(true);
		expect(isOwnLink('https://shop.example.com/', hosts)).toBe(true);
		expect(isOwnLink('https://shop.example.com', hosts)).toBe(true);
		expect(isOwnLink('https://SHOP.example.com/lamps/a?x=1#top', hosts)).toBe(true);
		expect(isOwnLink('https://www.shop.example.com/', hosts)).toBe(true);
	});
	it('refuses every other host, scheme, port, credentials and anything that is more than one address', () => {
		for (const link of [
			'https://evil.example/login',
			'https://shop.example.com.evil.example/',
			'https://evil.example/https://shop.example.com/',
			'http://shop.example.com/',
			'javascript:alert(1)',
			'//shop.example.com/',
			'/lamps/a',
			'shop.example.com',
			'https://shop.example.com:8443/',
			'https://shop.example.com@evil.example/',
			'https://user:pw@shop.example.com/',
			'https://shop.example.com\\@evil.example/',
			'https://shop.example.com/ and https://evil.example/',
			'https://shop.example.com/\nhttps://evil.example/',
			`https://shop.example.com/${'a'.repeat(2100)}`,
		])
			expect(isOwnLink(link, hosts), link).toBe(false);
		expect(isOwnLink('https://shop.example.com/', [])).toBe(false);
		expect(isOwnLink('https://shop.example.com/', [''])).toBe(false);
	});
});

describe('a link in a message (SR-7-3)', () => {
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let env;
	const mailed = () => JSON.parse(env.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}');
	const sentMails = () => env.providers.callsTo('https://api.resend.com').length;
	/** @param {Record<string, unknown>} [more] */
	const send = (more = {}) =>
		env.send('email', {
			...ALERT,
			values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link: `${ORIGIN}/lamps/a` },
			linkValues: ['link'],
			...more,
		});

	beforeAll(async () => {
		env = await setup();
		await env.switchOn(['email', 'send_api']);
		await env.connectDatabase();
		expect((await env.connect('email', RESEND)).status).toBe('connected');
	});

	it('sends a link on the website’s own domain, or an empty one, as it is', async () => {
		expect(await send()).toMatchObject({ status: 201, json: { status: 'sent' } });
		expect(mailed().text).toBe(`Hi Ana, Sam replied: Hello\n${ORIGIN}/lamps/a`);
		expect(await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link: '' } })).toMatchObject({
			status: 201,
			json: { status: 'sent' },
		});
	});

	it('refuses a link to another site, and sends nothing', async () => {
		const before = sentMails();
		for (const link of [
			'https://evil.example/login',
			'http://shop.example.com/',
			`${ORIGIN}@evil.example/`,
			`${ORIGIN}:8443/`,
		]) {
			const refused = await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link } });
			expect(refused.status, link).toBe(422);
			expect(refused.json.errors[0], link).toMatchObject({ path: '/values/link', code: 'link_not_allowed' });
		}
		expect(sentMails()).toBe(before);
		// the same address is plain text in a value no one named as a link: the caller's own choice, as before
		expect(
			await send({
				linkValues: undefined,
				values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link: 'https://evil.example/x' },
			}),
		).toMatchObject({
			status: 201,
		});
	});

	it('takes a host the merchant listed in the Portal, and not one it did not', async () => {
		const link = 'https://www.shop.example.com/lamps/a';
		const unlisted = await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link } });
		expect(unlisted.status).toBe(422);
		const business = portalSectionsOf(env.websiteId, { name: 'Shop', timeZone: 'UTC' });
		await env.setWebsite({ ...business, pages: { hosts: ['www.shop.example.com'], signIn: '', privacy: '', documents: [] } });
		expect(await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link } })).toMatchObject({
			status: 201,
			json: { status: 'sent' },
		});
		expect(mailed().text).toContain(link);
	});

	it('takes the host of the product the message belongs to', async () => {
		const own = 'https://chat.example.dev/inbox';
		expect((await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link: own } })).status).toBe(201);
		// another product’s host is not the website’s
		expect(
			(await send({ values: { name: 'Ana', staff: 'Sam', preview: 'Hello', link: 'https://ecommerce.example.dev/' } })).status,
		).toBe(422);
	});

	it('asks for a list of names, and keeps plain text plain', async () => {
		const bad = await send({ linkValues: 'link' });
		expect(bad.status).toBe(422);
		expect(bad.json.errors[0]).toMatchObject({ path: '/linkValues' });
		await send({
			values: { name: '<b>Ana</b>', staff: 'Sam', preview: '<a href="https://evil.example">x</a>', link: `${ORIGIN}/` },
		});
		expect(mailed().text).toBe(`Hi <b>Ana</b>, Sam replied: <a href="https://evil.example">x</a>\n${ORIGIN}/`);
		expect(mailed().html).toBeUndefined();
	});
});
