/**
 * Growth's part of the website Setup sheet (`GET /v1/blueprint`, a call signed by the Portal): features tagged with
 * the business profile answers they suit, the OpenAPI document named and served, the tags after consent, the number of
 * redirect rules (one count, only while Redirects is on and the merchant database is connected) and what the website
 * builds for each feature that is on, also shown in each feature of the docs.
 */
import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { BASE, setup } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof setup>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.close();
});

const start = async () => {
	const env = await setup();
	systems.push(env);
	return env;
};

/** @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('growth', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	expect(response.status).toBe(200);
	const body = await response.json();
	await env.flush();
	return body;
};

const build = /** @type {Record<string, string>} */ (guide.build);

describe('the website Setup sheet', () => {
	it('tags features with business profile answers and says what the website builds for each one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		expect(Object.keys(build)).toEqual(manifest.features.map((feature) => feature.key));
		expect(manifest.features.find((feature) => feature.key === 'conversion_funnel')?.recommendFor).toEqual([
			'marketing.analytics+sells.*',
		]);
		expect(manifest.features.find((feature) => feature.key === 'custom_scripts')?.recommendFor).toBeUndefined();
	});

	it('answers its part: the OpenAPI document, the tags after consent, and what to build for each feature on', async () => {
		const env = await start();
		const off = await partOf(env);
		expect(validateProductBlueprint(off).ok).toBe(true);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual([]);
		expect(off.summaries).toEqual([{ title: 'Tags after consent', text: 'No marketing tags are on.' }]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'redirects').recommendFor).toEqual([
			'moving.yes',
			'marketing.seo',
		]);

		// the banner asks first; Redirects is on, but without the merchant database there is nothing to count
		await env.switchOn(['meta_pixel', 'google_tags', 'consent_banner', 'redirects']);
		const on = await partOf(env);
		expect(validateProductBlueprint(on).ok).toBe(true);
		expect(on.summaries).toEqual([
			{ title: 'Tags after consent', text: 'Meta pixel, Google tags. The consent banner asks visitors first.' },
		]);
		expect(on.build).toEqual(
			['meta_pixel', 'google_tags', 'consent_banner', 'redirects'].map((feature) => ({
				feature,
				what: build[feature],
				docs: `${BASE}/docs#feature-${feature}`,
			})),
		);

		// without the banner, the tags wait for the merchant's own consent tool
		await env.switchOn(['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts']);
		expect((await partOf(env)).summaries).toEqual([
			{
				title: 'Tags after consent',
				text: "Meta pixel, Google tags, TikTok pixel, Custom scripts. The consent banner is off, so they wait until your own consent tool passes the visitor's choice on with SSGrowth.consent.set().",
			},
		]);

		// tags that do not wait for consent load at once
		await env.setting('tags', 'consentRequired', false);
		expect((await partOf(env)).summaries[0].text).toBe(
			"Meta pixel, Google tags, TikTok pixel, Custom scripts. They load at once, with Google Consent Mode granted, until the visitor chooses: 'Tags wait for the visitor's consent' is off (Settings → Tags and consent).",
		);

		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(await served.json()).toEqual(openapi);
	});

	it('counts the redirect rules with one read while Redirects is on and the merchant database is connected', async () => {
		const env = await start();
		await env.switchOn(['tiktok_pixel']);
		await env.connectDatabase();
		// Redirects off: no count
		const tagsOnly = await env.operationsDuring(async () => {
			expect((await partOf(env)).summaries).toEqual([
				{
					title: 'Tags after consent',
					text: "TikTok pixel. The consent banner is off, so they wait until your own consent tool passes the visitor's choice on with SSGrowth.consent.set().",
				},
			]);
		});
		expect(tagsOnly.total).toBe(0);

		await env.switchOn(['redirects']);
		/** @param {string} from @param {string} to */
		const rule = async (from, to) =>
			expect((await env.call('POST', '/v1/redirects', { token: env.server, body: { from, to } })).status).toBe(201);
		await rule('/old-page', '/new-page');
		/** @type {any} */
		let part = null;
		const counted = await env.operationsDuring(async () => {
			part = await partOf(env);
		});
		expect(counted).toEqual({ total: 1, names: ['aggregate ss_growth_redirects'] });
		expect(validateProductBlueprint(part).ok).toBe(true);
		expect(part.summaries).toEqual([
			{ title: 'Tags after consent', text: 'No marketing tags are on.' },
			{ title: 'Redirects', text: '1 rule.' },
		]);

		await rule('/old-blog', '/blog');
		expect((await partOf(env)).summaries[1]).toEqual({ title: 'Redirects', text: '2 rules.' });
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await start();
		const html = await (await env.call('GET', '/docs')).text();
		expect(html).toContain(
			'<p><strong>What your website builds.</strong> Your server or edge middleware applies the rules before it answers a request',
		);
		// every value is escaped
		expect(html).toContain('or where you place &#60;div data-ss-growth=&#34;notice_bar&#34;&#62;&#60;/div&#62;.');
		// a feature with no route or widget of its own (5 of the 15) shows no empty table or list
		expect(html).not.toContain('<tbody></tbody>');
		expect(html).not.toContain('<ul></ul>');
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
