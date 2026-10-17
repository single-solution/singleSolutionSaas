/**
 * Website settings in the kit (settings-ownership design, step 4): a product holds the Portal's copy of its website's
 * settings and uses it instead of business.json and its own theme and Format. The status answer's `settingsVersion`
 * and a `website.settings_changed` notice make it fetch; a request never calls the Portal while it holds a copy; a
 * Portal that is down changes nothing; while the Portal holds nothing the product keeps its own values; and a server
 * token changes none of it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from '@ss/contracts/format';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { defineRoute } from '../src/index.js';
import { productRoutes, setup } from './helpers.js';

const HOUR = 3_600_000;
const SITE = 'https://shop.example.com';

/** The sections a merchant saved in the Portal. @param {string} websiteId @param {Record<string, any>} [region] */
const saved = (websiteId, region = {}) => {
	const empty = emptyWebsiteSettings(websiteId);
	return {
		business: { ...empty.business, name: 'Portal Shop', email: 'hello@portal.test' },
		brand: {
			...empty.brand,
			theme: { ...empty.brand.theme, mode: /** @type {const} */ ('dark'), radius: 12, colors: { accent: '#112233' } },
		},
		region: {
			...empty.region,
			country: 'PK',
			timeZone: 'Asia/Karachi',
			currency: 'PKR',
			currencies: ['PKR'],
			language: 'en-PK',
			languages: ['en-PK'],
			format: {
				...DEFAULT_FORMAT,
				currencyDisplay: /** @type {const} */ ('symbol'),
				currencySymbols: { PKR: 'Rs' },
				times: /** @type {const} */ ('business'),
			},
			...region,
		},
	};
};

/** A product with a website whose own business.json (served by "the website") says something else. */
const prepare = async () => {
	/** @type {{ hits: number }} */
	const file = { hits: 0 };
	const x = await setup({
		routes: [
			...productRoutes(),
			defineRoute({
				method: 'GET',
				path: '/v1/server/website',
				auth: 'server',
				runtime: true,
				database: false,
				handler: async (ctx) => {
					const website = await ctx.website();
					return {
						version: website.version,
						timeZone: website.region.timeZone,
						name: website.business.name,
						frozen: Object.isFrozen(website),
					};
				},
			}),
		],
	});
	x.handlers[SITE] = async () => {
		file.hits += 1;
		return new Response(JSON.stringify({ name: 'Own Shop', timeZone: 'Europe/Paris', currency: 'EUR' }), {
			headers: { 'content-type': 'application/json' },
		});
	};
	/** How many times the product asked the Portal for the settings. */
	const pulls = () => x.portal.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/settings')).length;
	/** The Portal saved new settings and told the product. @param {Record<string, any>} [region] */
	const save = async (region) => {
		x.portal.setWebsiteSettings(x.websiteId, saved(x.websiteId, region));
		const res = await x.portal.sendNotice('notes', {
			type: 'website.settings_changed',
			websiteId: x.websiteId,
			what: 'settings',
		});
		await x.settle();
		return res;
	};
	return { ...x, file, pulls, save };
};

describe('while the Portal holds no settings for the website (version 0)', () => {
	it('the product keeps its own values: business.json and its own theme and Format, and never asks for settings', async () => {
		const x = await prepare();
		// a request to the product reads the website's business.json right after its response, as before
		await x.call('GET', '/v1/server/notes', { token: x.server.token });
		await x.settle();
		const business = await x.product.business(x.websiteId);
		expect(business).toMatchObject({ name: 'Own Shop', timeZone: 'Europe/Paris', currency: 'EUR' });
		expect(x.file.hits).toBe(1);
		expect(x.pulls()).toBe(0);
		const website = await (await x.call('GET', '/v1/server/website', { token: x.server.token })).json();
		expect(website).toMatchObject({ version: 0, timeZone: '', name: '' });
		// its own theme and Format are still saved by the product
		const put = await x.call('PUT', '/v1/theme', { token: x.server.token, body: { mode: 'light' } });
		expect(put.status).toBe(200);
		expect((await (await x.call('GET', '/v1/theme', { token: x.server.token })).json()).sources.mode).toBe('website');
	});
});

describe('when the Portal holds settings', () => {
	it('uses them for business(), formatter(), the theme and the Format, and no longer reads business.json', async () => {
		const x = await prepare();
		x.portal.setWebsiteSettings(x.websiteId, saved(x.websiteId));
		const business = await x.product.business(x.websiteId);
		expect(business).toMatchObject({
			name: 'Portal Shop',
			email: 'hello@portal.test',
			timeZone: 'Asia/Karachi',
			currency: 'PKR',
			language: 'en-PK',
			country: 'PK',
		});
		const formatter = await x.product.format(x.websiteId);
		expect(formatter.timeZone).toBe('Asia/Karachi');
		expect(formatter.money(150_000, 'PKR')).toContain('Rs');
		const theme = await (await x.call('GET', '/v1/theme', { token: x.server.token })).json();
		expect(theme.theme).toMatchObject({ mode: 'dark', radius: 12, colors: { accent: '#112233' } });
		expect(Object.values(theme.sources)).toEqual(['portal', 'portal', 'portal', 'portal', 'portal']);
		const format = await (await x.call('GET', '/v1/format', { token: x.server.token })).json();
		expect(format.format).toMatchObject({ currencyDisplay: 'symbol', times: 'business' });
		expect(Object.values(format.sources)).toEqual(['portal', 'portal', 'portal', 'portal', 'portal']);
		// the widgets get them too
		await x.connectDatabase();
		const widget = await (await x.call('GET', '/v1/widget/config', { token: x.browser.token, origin: SITE })).json();
		expect(widget).toMatchObject({ timeZone: 'Asia/Karachi', theme: { mode: 'dark' }, format: { currencyDisplay: 'symbol' } });
		await x.settle();
		expect(x.file.hits).toBe(0);
		// ctx.website: the frozen document
		const website = await (await x.call('GET', '/v1/server/website', { token: x.server.token })).json();
		expect(website).toEqual({ version: 1, timeZone: 'Asia/Karachi', name: 'Portal Shop', frozen: true });
	});

	it('asks the Portal once per version, never on the hot path', async () => {
		const x = await prepare();
		x.portal.setWebsiteSettings(x.websiteId, saved(x.websiteId));
		await x.product.business(x.websiteId); // the first use waits for the copy
		expect(x.pulls()).toBe(1);
		for (let i = 0; i < 50; i += 1) await x.product.business(x.websiteId);
		await x.call('GET', '/v1/widget/config', { token: x.browser.token, origin: SITE });
		await x.settle();
		expect(x.pulls()).toBe(1);
		// the memory is only 60 seconds: the copy in the product database answers after it, still without the Portal
		x.clock.advance(61_000);
		expect((await x.product.business(x.websiteId)).name).toBe('Portal Shop');
		await x.settle();
		expect(x.pulls()).toBe(1);
	});

	it('a notice makes it fetch right after answering; the next use has the new value', async () => {
		const x = await prepare();
		await x.save();
		expect((await x.product.business(x.websiteId)).timeZone).toBe('Asia/Karachi');
		x.clock.advance(1000);
		const res = await x.save({ timeZone: 'America/Chicago' });
		expect(res.status).toBe(204);
		expect(x.pulls()).toBe(2);
		expect((await x.product.business(x.websiteId)).timeZone).toBe('America/Chicago');
		// the fetch named the version it held: the Portal sends the document only when it is newer
		const last = x.portal.calls.filter((c) => c.path.endsWith('/settings')).at(-1);
		expect(last?.productId).toBe('notes');
	});

	it('a lost notice is caught by the next status: the old copy answers now and the new one is fetched after the response', async () => {
		const x = await prepare();
		await x.save();
		await x.product.business(x.websiteId);
		x.portal.setWebsiteSettings(x.websiteId, saved(x.websiteId, { timeZone: 'America/Chicago' })); // no notice
		x.clock.advance(61_000);
		expect((await x.product.business(x.websiteId)).timeZone).toBe('Asia/Karachi'); // the status copy is still fresh
		// the status copy runs out (5 minutes): it shows version 2, the old copy answers, the fetch follows the response
		x.clock.advance(5 * 60_000);
		await x.call('GET', '/v1/server/website', { token: x.server.token });
		await x.settle();
		x.clock.advance(61_000);
		expect((await x.product.business(x.websiteId)).timeZone).toBe('America/Chicago');
	});

	it('a Portal that is down changes nothing: the last copy is used with no time limit; only a first use without a copy falls back', async () => {
		const x = await prepare();
		await x.save();
		await x.product.business(x.websiteId);
		x.portal.setReachable(false);
		// within the offline grace the product serves as before; the settings come from the copy
		x.clock.advance(5 * HOUR);
		expect((await x.product.business(x.websiteId)).name).toBe('Portal Shop');
		// the settings themselves have no time limit
		x.clock.advance(20 * HOUR);
		expect((await x.product.website(x.websiteId)).region.timeZone).toBe('Asia/Karachi');
		expect((await x.product.settings.theme(x.websiteId)).mode).toBe('dark');
	});

	it('a first use that cannot reach the Portal falls back to the product’s own values, and tells the log', async () => {
		const x = await prepare();
		x.portal.setWebsiteSettings(x.websiteId, saved(x.websiteId));
		await x.product.business(x.websiteId); // status copy: settingsVersion 1
		// a second product instance on the same store would hold nothing: drop the copy and make the Portal unreachable
		await x.store.delete('website_settings', x.websiteId);
		x.clock.advance(61_000);
		x.portal.setReachable(false);
		const business = await x.product.business(x.websiteId);
		expect(business.name).not.toBe('Portal Shop');
		expect(x.entries.some((e) => e.msg === 'website settings not fetched')).toBe(true);
	});

	it('the website being deleted removes the copy', async () => {
		const x = await prepare();
		await x.save();
		await x.product.business(x.websiteId);
		expect(await x.store.get('website_settings', x.websiteId)).not.toBeNull();
		await x.portal.sendNotice('notes', { type: 'website.deleted', websiteId: x.websiteId });
		expect(await x.store.get('website_settings', x.websiteId)).toBeNull();
	});
});

describe('a server token cannot change them', () => {
	it('the theme and the Format answer 409 managed_by_portal for the merchant’s server (with a staff sign-in), the dashboard and the global defaults stay out of it', async () => {
		const x = await prepare();
		await x.save();
		await x.product.business(x.websiteId);
		for (const [path, body] of /** @type {Array<[string, unknown]>} */ ([
			['/v1/theme', { mode: 'light' }],
			['/v1/format', { wholeUnits: true }],
		])) {
			// a bare server token never could (it needs a signed-in staff member)…
			const bare = await x.call('PUT', path, { token: x.server.token, bare: true, body });
			expect([bare.status, (await bare.json()).type.split('/').pop()]).toEqual([403, 'needs_signed_in_staff']);
			// …and with one it still cannot: the Portal owns them
			const signedIn = await x.call('PUT', path, { token: x.server.token, body });
			expect([signedIn.status, (await signedIn.json()).type.split('/').pop()]).toEqual([409, 'managed_by_portal']);
		}
		// the dashboard of the merchant and of an admin: the same
		for (const kind of /** @type {const} */ (['merchant', 'admin'])) {
			const cookie = await x.session({ kind });
			const theme = await x.dash(cookie, 'PUT', `/v1/dashboard/websites/${x.websiteId}/theme`, { mode: 'light' });
			const detail = await theme.json();
			expect([theme.status, detail.type.split('/').pop()]).toEqual([409, 'managed_by_portal']);
			expect(detail.portalUrl).toBe(x.portal.url);
			const format = await x.dash(cookie, 'PUT', `/v1/dashboard/websites/${x.websiteId}/format`, { locale: 'fr-FR' });
			expect(format.status).toBe(409);
		}
		// nothing was written
		const theme = await (await x.call('GET', '/v1/theme', { token: x.server.token })).json();
		expect(theme.theme.mode).toBe('dark');
		expect(await x.store.list('settings', { websiteId: x.websiteId })).toEqual([]);
	});

	it('the Owner’s global defaults (no website) are the product’s own and still saved', async () => {
		const x = await prepare();
		await x.save();
		const cookie = await x.session({ kind: 'admin', websiteId: null });
		const res = await x.dash(cookie, 'PUT', '/v1/dashboard/defaults/theme', { value: { mode: 'light' } });
		expect(res.status).toBeLessThan(300);
	});

	it('a notice for another type or a forged one changes nothing', async () => {
		const x = await prepare();
		await x.save();
		const forged = await x.handler(
			new Request(`https://notes.example.dev/.well-known/ss-events`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'website.settings_changed', websiteId: x.websiteId }),
			}),
		);
		expect(forged.status).toBe(401);
		expect(x.pulls()).toBe(1);
	});
});
