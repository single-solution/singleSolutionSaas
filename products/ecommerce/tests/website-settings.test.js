/**
 * What Ecommerce takes from the website's settings in the Portal (settings-ownership design, step 5): settings that start
 * from the Portal's value until the merchant saves their own, the privacy policy and terms that are the website's
 * documents, the Overview's "Needs setup" for the currency and country the Portal still lacks, and the settings that
 * Ecommerce no longer has because the Portal owns them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** The value of one setting as the settings API shows it. @param {string} feature @param {string} name */
const read = async (feature, name) => {
	const features = (await shop.api('GET', '/v1/settings')).json.features;
	return features.find((/** @type {any} */ f) => f.key === feature).values[name];
};

describe('settings that start from the Portal', () => {
	it('start from the website’s language, name and tagline until the merchant saves their own', async () => {
		const region = { ...shop.site.region, language: 'fr-FR', languages: ['fr-FR'] };
		await shop.setWebsite({ region, business: { ...shop.site.business, name: 'Maison', tagline: 'Tout pour la maison' } });
		expect(await read('ai_copy', 'language')).toEqual({ value: 'fr-FR', source: 'portal', from: 'region.language' });
		expect(await read('seo', 'homeTitle')).toEqual({ value: 'Maison', source: 'portal', from: 'business.name' });
		expect(await read('seo', 'homeDescription')).toEqual({
			value: 'Tout pour la maison',
			source: 'portal',
			from: 'business.tagline',
		});
		// the shop's home page starts from them
		const site = (await shop.api('GET', '/v1/seo/site')).json;
		expect(site.title).toBe('Maison');
		expect(site.description).toBe('Tout pour la maison');
		// the merchant's own value wins, and the Portal's keeps showing as the start of the other settings
		const cookie = await shop.adminSession();
		const base = `/v1/dashboard/websites/${shop.websiteId}`;
		expect((await shop.dashboard(cookie, 'PUT', `${base}/settings/seo.homeTitle`, { value: 'Our own title' })).status).toBe(
			204,
		);
		expect(await read('seo', 'homeTitle')).toMatchObject({ value: 'Our own title', source: 'website' });
		expect((await shop.api('GET', '/v1/seo/site')).json.title).toBe('Our own title');
		expect(await read('seo', 'homeDescription')).toMatchObject({ source: 'portal' });
		// a change in the Portal reaches the settings that still start from it
		await shop.setWebsite({ business: { ...shop.site.business, tagline: 'Everything for the home' } });
		expect((await read('seo', 'homeDescription')).value).toBe('Everything for the home');
	});

	it('show their own default while the Portal holds no value for them', async () => {
		await shop.setWebsite({ region: { ...shop.site.region, language: '', languages: [] } });
		expect(await read('ai_copy', 'language')).toMatchObject({ value: '', source: 'built-in' });
	});
});

describe('the privacy policy and the terms', () => {
	it('are the website’s documents in the Portal, shown after the shop’s own policies, filled like them', async () => {
		const own = (await shop.api('GET', '/v1/policies')).json.policies.map((/** @type {any} */ p) => p.key);
		expect(own).not.toContain('privacy');
		await shop.setWebsite({
			pages: {
				...shop.site.pages,
				documents: [
					{ key: 'privacy', title: 'Privacy policy', text: '<p>We keep {email} private.</p>' },
					{ key: 'terms', title: 'Terms and conditions', text: '<p>Orders by {business}.</p>' },
				],
			},
		});
		const answer = (await shop.api('GET', '/v1/policies')).json.policies;
		const byKey = Object.fromEntries(answer.map((/** @type {any} */ p) => [p.key, p]));
		expect(byKey.privacy).toMatchObject({ title: 'Privacy policy' });
		expect(byKey.privacy.text).toContain('hello@shop.example.com');
		expect(byKey.terms.text).toContain('Orders by');
		// the Portal's document comes after the shop's own, and replaces a policy of the same key
		const keys = answer.map((/** @type {any} */ p) => p.key);
		expect(keys.indexOf('privacy')).toBeGreaterThan(keys.indexOf('returns'));
		await shop.list('policies', [{ key: 'terms', title: 'Mine', text: '<p>Old terms</p>' }]);
		const replaced = (await shop.api('GET', '/v1/policies')).json.policies.filter((/** @type {any} */ p) => p.key === 'terms');
		expect(replaced).toHaveLength(1);
		expect(replaced[0].title).toBe('Terms and conditions');
		await shop.setWebsite({ pages: { ...shop.site.pages, documents: [] } });
		expect((await shop.api('GET', '/v1/policies')).json.policies.map((/** @type {any} */ p) => p.key)).toEqual(['terms']);
	});
});

describe('what the Overview asks of the Portal', () => {
	it('lists the currency and the country the Portal still lacks, and nothing once they are set', async () => {
		const cookie = await shop.adminSession();
		const website = async () =>
			(await shop.dashboard(cookie, 'GET', `/v1/dashboard/websites/${shop.websiteId}/overview`)).json.checklist.website;
		await shop.setWebsite({ region: { ...shop.site.region, currency: '', currencies: [], country: '' } });
		// the product's own needs, and those of a feature that is on (the alert team, for staff alerts)
		expect(await website()).toMatchObject({
			requires: ['region.currency', 'region.country', 'team.recipients'],
			missing: ['region.currency', 'region.country', 'team.recipients'],
		});
		await shop.setBusiness({ country: 'US', currency: 'USD' });
		expect(await website()).toMatchObject({
			requires: ['region.currency', 'region.country', 'team.recipients'],
			missing: ['team.recipients'],
		});
	});
});

describe('the settings the Portal owns now', () => {
	it('are not Ecommerce settings any more: no currency, units, phone rules, address rules, brand name or team', async () => {
		const features = (await shop.api('GET', '/v1/settings')).json.features;
		const has = (/** @type {string} */ feature, /** @type {string} */ name) =>
			Object.keys(features.find((/** @type {any} */ f) => f.key === feature).values).includes(name);
		for (const [feature = '', name = ''] of [
			['catalog', 'currency'],
			['catalog', 'weightUnit'],
			['catalog', 'sizeUnit'],
			['checkout', 'addressRequired'],
			['checkout', 'defaultCallingCode'],
			['checkout', 'trunkPrefix'],
			['checkout', 'countries'],
			['seo', 'brandName'],
			['seo', 'alternateName'],
			['seo', 'businessType'],
			['seo', 'socialProfiles'],
			['seo', 'defaultImage'],
			['staff_alerts', 'recipients'],
			['staff_alerts', 'phoneChannel'],
			['staff_alerts', 'staffPush'],
			['invoices', 'sellerDetails'],
		])
			expect([feature, name, has(feature, name)]).toEqual([feature, name, false]);
		// saving one is refused, not silently kept
		const cookie = await shop.adminSession();
		const refused = await shop.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${shop.websiteId}/settings/catalog.currency`, {
			value: 'EUR',
		});
		expect(refused.status).toBeGreaterThanOrEqual(400);
		expect(refused.status).toBeLessThan(500);
	});

	it('the Portal’s currency is the one the shop uses, and a change reaches the widgets', async () => {
		const before = shop.site.region;
		try {
			await shop.setWebsite({ region: { ...before, currency: 'EUR', currencies: ['EUR'] } });
			expect(JSON.stringify((await shop.visitor('GET', '/v1/widget/config')).json)).toContain('EUR');
		} finally {
			await shop.setWebsite({ region: before });
		}
	});
});
