import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { BASE, setup } from './helpers.js';

/** @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('payments', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	const body = await response.json();
	await env.flush();
	return body;
};

describe('the website Setup sheet', () => {
	it('tags features with business profile answers and says what the website builds for each one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		const build = /** @type {Record<string, string>} */ (guide.build);
		expect(Object.keys(build).sort()).toEqual(manifest.features.map((feature) => feature.key).sort());
		expect(manifest.features.find((feature) => feature.key === 'payfast_pk')?.recommendFor).toEqual([
			'pays.online+countries.pk',
		]);
	});

	it('answers its part: the OpenAPI document, events, gateways on, and what to build for each feature on', async () => {
		const env = await setup();
		const off = await partOf(env);
		expect(validateProductBlueprint(off).ok).toBe(true);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual([
			'payments.settings.changed',
			'payments.payment.paid',
			'payments.payment.failed',
			'payments.payment.refunded',
			'payments.payment.proof_uploaded',
			'payments.subscription.updated',
		]);
		expect(off.summaries).toEqual([
			{ title: 'Gateways on', text: 'None yet, so payers cannot pay. Switch a gateway on and connect it.' },
		]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'stripe').recommendFor).toEqual([
			'pays.online',
			'sells.subscriptions',
		]);

		await env.switchOn(['stripe', 'paypal', 'jazzcash', 'bank_transfer', 'payment_api']);
		const on = await partOf(env);
		expect(on.summaries[0].text).toBe(
			'Stripe: any currency. PayPal: 24 currencies. JazzCash (Pakistan): PKR. Bank transfer (manual): any currency.',
		);
		expect(on.build.map((/** @type {any} */ entry) => entry.feature)).toEqual([
			'stripe',
			'paypal',
			'jazzcash',
			'bank_transfer',
			'payment_api',
		]);
		expect(on.build[4]).toEqual({
			feature: 'payment_api',
			what: /** @type {Record<string, string>} */ (guide.build).payment_api,
			docs: `${BASE}/docs#feature-payment_api`,
		});
		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(served.json).toEqual(openapi);
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await setup();
		const docs = await env.call('GET', '/docs');
		expect(docs.text).toContain('<p><strong>What your website builds.</strong> Create links with POST /v1/links');
		// a feature with no route or widget of its own (8 of the 13) shows no empty table or list
		expect(docs.text).not.toContain('<tbody></tbody>');
		expect(docs.text).not.toContain('<ul></ul>');
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
