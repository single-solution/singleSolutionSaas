import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { BASE, setup } from './helpers.js';

/** @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('notifications', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	const body = await response.json();
	await env.flush();
	return body;
};

const build = /** @type {Record<string, string>} */ (guide.build);

describe('the website Setup sheet', () => {
	it('tags features with business profile answers and says what the website builds for each one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		expect(Object.keys(build)).toEqual(manifest.features.map((feature) => feature.key));
		expect(manifest.features.find((feature) => feature.key === 'fallback')?.recommendFor).toEqual([
			'messages.whatsapp+messages.sms',
			'messages.whatsapp+messages.email',
			'messages.sms+messages.email',
		]);
		expect(manifest.features.find((feature) => feature.key === 'quiet_hours')?.recommendFor).toBeUndefined();
	});

	it('answers its part: the OpenAPI document, the channels on, the webhook events and URLs by host, what to build', async () => {
		const env = await setup();
		const off = await partOf(env);
		expect(validateProductBlueprint(off).ok).toBe(true);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual([]);
		expect(off.summaries).toEqual([{ title: 'Channels', text: 'None is on yet, so nothing can be sent to customers.' }]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'sms').recommendFor).toEqual(['messages.sms', 'signIn.phone']);

		await env.switchOn(['whatsapp', 'email', 'staff_push', 'webhooks', 'send_api']);
		const value = [
			{ url: 'https://hooks.example.com/ss?token=tok-0123456789', events: [] },
			{ url: 'https://api.example.com:8443/notify/key-abcdefghij', events: ['message.failed', 'payments.payment.paid'] },
			{ url: 'https://hooks.example.com/other', events: ['message.sent'] },
		];
		expect((await env.call('PUT', '/v1/lists/webhook_urls', { token: env.server, body: { value } })).status).toBe(200);
		await env.setting('webhooks', 'events', ['message.failed', 'recipient.unsubscribed']);
		const on = await partOf(env);
		expect(validateProductBlueprint(on).ok).toBe(true);
		expect(on.summaries).toEqual([
			{ title: 'Channels', text: 'WhatsApp, Email.' },
			{
				title: 'Webhook events',
				text: 'message.failed, recipient.unsubscribed, plus the events other products forward (for example payments.payment.paid).',
			},
		]);
		expect(on.features.find((/** @type {any} */ f) => f.key === 'webhooks').lists).toEqual([
			{
				name: 'webhook_urls',
				title: 'Webhook URLs',
				summary: '3 URLs on hooks.example.com and api.example.com; 1 takes every event.',
				count: 3,
			},
		]);
		// hosts only: a path or a query may hold a token
		const text = JSON.stringify(on);
		for (const part of ['tok-0123456789', 'token=', 'key-abcdefghij', '/notify', ':8443']) expect(text).not.toContain(part);
		expect(on.build.map((/** @type {any} */ entry) => entry.feature)).toEqual([
			'whatsapp',
			'email',
			'staff_push',
			'webhooks',
			'send_api',
		]);
		expect(on.build[3]).toEqual({ feature: 'webhooks', what: build.webhooks, docs: `${BASE}/docs#feature-webhooks` });

		// none of its own events picked: only other products' go out
		await env.setting('webhooks', 'events', []);
		expect((await partOf(env)).summaries[1]).toEqual({
			title: 'Webhook events',
			text: "None of Notifications' own; only the events other products forward (for example payments.payment.paid).",
		});
		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(await served.json()).toEqual(openapi);
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await setup();
		const docs = await (await env.call('GET', '/docs')).text();
		expect(docs).toContain('<section id="feature-email"><h3>Email</h3>');
		expect(docs).toContain(
			'<p><strong>What your website builds.</strong> Nothing on your pages: connect your email provider in Connections',
		);
		expect(docs.match(/What your website builds\./g)).toHaveLength(manifest.features.length);
	});

	it('reaches the docs and the OpenAPI document through the Next.js rewrites', async () => {
		const rewrites = /** @type {Array<{ source: string, destination: string }>} */ (await nextConfig.rewrites?.());
		expect(rewrites).toEqual(
			expect.arrayContaining([
				{ source: '/docs', destination: '/api/docs' },
				{ source: '/openapi.json', destination: '/api/openapi.json' },
			]),
		);
	});
});
