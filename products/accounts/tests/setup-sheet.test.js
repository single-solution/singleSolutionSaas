import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { BASE, setup } from './helpers.js';

/** @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('accounts', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	const body = await response.json();
	await env.flush();
	return body;
};

describe('the website Setup sheet', () => {
	it('tags features with business profile answers and says what the website builds for each one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		const build = /** @type {Record<string, string>} */ (guide.build);
		expect(Object.keys(build)).toEqual(manifest.features.map((feature) => feature.key));
		expect(manifest.features.find((feature) => feature.key === 'orders_tab')?.recommendFor).toEqual(['signIn.*+sells.*']);
	});

	it('answers its part: the OpenAPI document, the sign-in methods, who can sign up, and what to build for each feature on', async () => {
		const env = await setup();
		const off = await partOf(env);
		expect(validateProductBlueprint(off).ok).toBe(true);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual([]);
		expect(off.summaries).toEqual([{ title: 'Sign-in methods', text: 'None is on yet, so nobody can sign in.' }]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'roles').recommendFor).toEqual([
			'signIn.*',
			'offers.member_prices',
		]);

		await env.switchOn(['phone_code', 'email_password', 'google', 'approval']);
		const on = await partOf(env);
		expect(validateProductBlueprint(on).ok).toBe(true);
		expect(on.summaries).toEqual([
			{ title: 'Sign-in methods', text: 'Phone code, Email + password, Google.' },
			{ title: 'Sign-up', text: 'Sign-ups wait for your approval.' },
		]);
		expect(on.build.map((/** @type {any} */ entry) => entry.feature)).toEqual([
			'phone_code',
			'email_password',
			'google',
			'approval',
		]);
		expect(on.build[2]).toEqual({
			feature: 'google',
			what: /** @type {Record<string, string>} */ (guide.build).google,
			docs: `${BASE}/docs#feature-google`,
		});

		// who can sign up follows the sign-up mode of Approval / invite sign-up (default: approval)
		await env.setting('approval', 'mode', 'invite');
		expect((await partOf(env)).summaries[1]).toEqual({ title: 'Sign-up', text: 'Only people you invite can sign up.' });
		await env.setting('approval', 'mode', 'open');
		expect((await partOf(env)).summaries[1]).toEqual({ title: 'Sign-up', text: 'Anyone can sign up.' });

		// unified sign_in capability umbrella
		await env.switchOn(['sign_in', 'approval']);
		const umbrella = await partOf(env);
		expect(validateProductBlueprint(umbrella).ok).toBe(true);
		expect(umbrella.summaries[0].title).toBe('Sign-in methods');
		expect(umbrella.build.map((/** @type {any} */ entry) => entry.feature)).toContain('sign_in');

		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(served.json).toEqual(openapi);
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await setup();
		const docs = await env.call('GET', '/docs');
		expect(docs.text).toContain(
			'<p><strong>What your website builds.</strong> In your Google OAuth client, add the return address shown in Connections',
		);
		expect(docs.text).toContain(
			'<p><strong>What your website builds.</strong> Add a page with &#60;div data-ss-accounts=&#34;role_request&#34;&#62;&#60;/div&#62;',
		);
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
