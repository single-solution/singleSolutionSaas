import { describe, expect, it } from 'vitest';
import { validateBusinessJson, validateManifest, validateStatusResponse, validateWebsiteSettings } from '../src/index.js';
import { DEFAULT_FORMAT } from '../src/format.js';
import { SCHEMA_IDS } from '../src/schemas/index.js';
import {
	WEBSITE_SETTINGS_MAX_BYTES,
	WEBSITE_SETTINGS_PATHS,
	WEBSITE_SETTINGS_SCHEMA,
	WEBSITE_SETTINGS_SECTIONS,
	businessInfoOf,
	emptyWebsiteSettings,
	formatOf,
	isUnsetWebsiteValue,
	isWebsiteSettingsPath,
	missingWebsiteSettings,
	tidyWebsiteSection,
	themeOf,
	websiteSectionOf,
	websiteSettingAt,
	websiteSettingKind,
} from '../src/website-settings.js';
import { WEBSITE, statusResponse } from './fixtures.js';
import { manifest } from '../src/testing.js';
import { expectProblem } from './helpers.js';

/** A complete document: every section filled. */
const full = () => {
	const settings = emptyWebsiteSettings(WEBSITE);
	return /** @type {import('../src/types.js').WebsiteSettings} */ ({
		...settings,
		version: 3,
		updatedAt: '2026-10-17T12:00:00Z',
		business: {
			name: 'Example Shop',
			otherNames: ['Example'],
			tagline: 'Good things',
			legalName: 'Example Shop LLC',
			taxNumber: 'TX-123',
			businessType: 'Clothing store',
			email: 'hello@example.com',
			phone: '+1 555 0100',
			phones: [{ label: 'Sales', number: '+1 555 0101' }],
			whatsapp: '+1 555 0102',
			address: {
				line1: '1 Example Street',
				line2: '',
				area: '',
				city: 'Springfield',
				region: 'IL',
				postalCode: '62701',
				country: 'US',
			},
			hours: {
				weekly: [{ day: 1, start: '09:00', end: '17:00' }],
				exceptions: [{ date: '2026-12-25', name: 'Christmas', hours: [] }],
			},
			social: [{ label: 'Instagram', url: 'https://instagram.com/example' }],
		},
		brand: {
			files: {
				logo: 'https://cdn.example.com/logo.png',
				logoDark: '',
				icon: 'https://cdn.example.com/icon.png',
				favicon: '',
				faviconDark: '',
				shareImage: '',
			},
			theme: { mode: 'dark', fontFamily: 'Inter', radius: 12, colors: { accent: '#2471e7' }, customCss: '.a { color: red }' },
		},
		region: {
			country: 'US',
			timeZone: 'America/New_York',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
			language: 'en-US',
			languages: ['en-US', 'fr-FR'],
			countriesServed: ['US', 'CA'],
			units: { weight: 'lb', size: 'in' },
			format: {
				locale: 'en-US',
				currencyDisplay: 'symbol',
				currencySymbols: { USD: '$' },
				wholeUnits: false,
				times: 'business',
			},
			phone: { callingCode: '+1', trunkPrefix: '1', countries: ['US', 'CA'] },
			address: { required: ['line1', 'city'], regions: [{ country: 'US', names: ['Illinois', 'Ohio'] }] },
		},
		pages: {
			hosts: ['www.example.com'],
			signIn: 'https://example.com/sign-in',
			privacy: 'https://example.com/privacy',
			documents: [{ key: 'terms', title: 'Terms', text: 'Terms of {business}.' }],
		},
		team: {
			recipients: [{ name: 'Ann', email: 'ann@example.com', phone: '+1 555 0103' }],
			phoneChannel: 'sms',
			staffPush: true,
			support: { email: 'help@example.com', phone: '' },
		},
	});
};

describe('the website-settings document (ss.website-settings/1)', () => {
	it('names its schema and its five sections', () => {
		expect(WEBSITE_SETTINGS_SCHEMA).toBe('ss.website-settings/1');
		expect(SCHEMA_IDS.websiteSettings).toMatch(/website-settings$/);
		expect(WEBSITE_SETTINGS_SECTIONS).toEqual(['business', 'brand', 'region', 'pages', 'team']);
	});

	it('accepts the empty document of a website nothing was saved for (version 0) and a complete one', () => {
		const empty = emptyWebsiteSettings(WEBSITE);
		expect(empty).toMatchObject({ schema: WEBSITE_SETTINGS_SCHEMA, websiteId: WEBSITE, version: 0, updatedAt: null });
		expect(validateWebsiteSettings(empty).ok).toBe(true);
		expect(validateWebsiteSettings(full()).ok).toBe(true);
		// no secret has a place in it: it is shown on the Setup sheet and may be logged
		expect(JSON.stringify(full())).not.toMatch(/token|secret|password|apiKey/i);
	});

	/** @type {Array<[string, (s: any) => unknown, string]>} */
	const refusals = [
		['an unknown member', (s) => (s.region.secret = 'x'), '/region/secret'],
		['an unknown section', (s) => (s.extra = {}), '/extra'],
		['another schema', (s) => (s.schema = 'ss.website-settings/2'), '/schema'],
		['a time zone the runtime does not know', (s) => (s.region.timeZone = 'Mars/Base'), '/region/timeZone'],
		['a country written in three letters', (s) => (s.region.country = 'USA'), '/region/country'],
		['a currency written in lower case', (s) => (s.region.currency = 'usd'), '/region/currency'],
		['a language that is not canonical', (s) => (s.region.language = 'en-us'), '/region/language'],
		['a store currency that is not first in the list', (s) => (s.region.currencies = ['EUR', 'USD']), '/region/currencies'],
		['the same currency twice', (s) => (s.region.currencies = ['USD', 'USD']), '/region/currencies'],
		['a default language that is not first in the list', (s) => (s.region.languages = ['fr-FR', 'en-US']), '/region/languages'],
		['a logo on http', (s) => (s.brand.files.logo = 'http://example.com/logo.png'), '/brand/files/logo'],
		['a logo address with a password', (s) => (s.brand.files.logo = 'https://a:b@example.com/l.png'), '/brand/files/logo'],
		['a theme color that is not #rrggbb', (s) => (s.brand.theme.colors.accent = 'blue'), '/brand/theme/colors/accent'],
		['a theme radius over 24', (s) => (s.brand.theme.radius = 25), '/brand/theme/radius'],
		['custom CSS over 20 kB', (s) => (s.brand.theme.customCss = 'a'.repeat(20 * 1024 + 1)), '/brand/theme/customCss'],
		['a Format field out of range', (s) => (s.region.format.times = 'sometimes'), '/region/format/times'],
		[
			'two opening windows of one day that overlap',
			(s) => s.business.hours.weekly.push({ day: 1, start: '16:00', end: '18:00' }),
			'/business/hours/weekly',
		],
		[
			'an opening window that ends before it starts',
			(s) => (s.business.hours.weekly[0] = { day: 1, start: '17:00', end: '09:00' }),
			'/business/hours/weekly/0',
		],
		[
			'a date that does not exist',
			(s) => (s.business.hours.exceptions[0].date = '2026-02-30'),
			'/business/hours/exceptions/0/date',
		],
		['an email that is not one', (s) => (s.business.email = 'hello'), '/business/email'],
		['a name with a control character', (s) => (s.business.name = 'Shop\u0007'), '/business/name'],
		['a country in the address that is not a country', (s) => (s.business.address.country = 'ZZ'), '/business/address/country'],
		['a host name twice', (s) => (s.pages.hosts = ['www.example.com', 'www.example.com']), '/pages/hosts'],
		['a document key twice', (s) => s.pages.documents.push({ key: 'terms', title: 'T', text: 't' }), '/pages/documents'],
		[
			'an alert recipient with no email and no phone',
			(s) => (s.team.recipients[0] = { name: 'Bo', email: '', phone: '' }),
			'/team/recipients/0',
		],
		['a phone channel that does not exist', (s) => (s.team.phoneChannel = 'fax'), '/team/phoneChannel'],
		['a negative version', (s) => (s.version = -1), '/version'],
	];
	it.each(refusals)('refuses %s', (_name, mutate, path) => {
		const value = full();
		mutate(value);
		expectProblem(validateWebsiteSettings(value), path);
	});

	it('refuses a document over 64 kB', () => {
		const value = full();
		value.pages.documents = Array.from({ length: 10 }, (_, i) => ({ key: `doc${i}`, title: 'T', text: 'x'.repeat(8000) }));
		const result = validateWebsiteSettings(value);
		expect(JSON.stringify(value).length).toBeGreaterThan(WEBSITE_SETTINGS_MAX_BYTES);
		expectProblem(result, '');
	});

	it('answers the shapes products already use, exactly (golden): business.json, Format and the theme', () => {
		const settings = full();
		const info = businessInfoOf(settings);
		expect(info).toEqual({
			name: 'Example Shop',
			logo: 'https://cdn.example.com/logo.png',
			email: 'hello@example.com',
			phone: '+1 555 0100',
			address: '1 Example Street\nSpringfield, IL 62701',
			country: 'US',
			timeZone: 'America/New_York',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
			language: 'en-US',
		});
		// a product can hand it to a website as its business.json, and the old validator takes it as it is
		expect(validateBusinessJson(info).ok).toBe(true);
		expect(formatOf(settings)).toEqual(settings.region.format);
		expect(themeOf(settings)).toEqual(settings.brand.theme);
	});

	it('answers the defaults a website has before anything is saved: no facts, UTC left to the product, the default Format and theme', () => {
		const empty = emptyWebsiteSettings(WEBSITE);
		expect(businessInfoOf(empty)).toEqual({
			name: '',
			logo: null,
			email: null,
			phone: null,
			address: null,
			country: null,
			timeZone: null,
			currency: null,
			currencies: [],
			language: null,
		});
		expect(formatOf(empty)).toEqual(DEFAULT_FORMAT);
		expect(themeOf(empty)).toEqual({ colors: {}, fontFamily: 'inherit', radius: 8, mode: 'auto', customCss: '' });
	});

	it('takes the main phone from the phone list and the country from the address when the region names none', () => {
		const settings = full();
		settings.business.phone = '';
		settings.region.country = '';
		const info = businessInfoOf(settings);
		expect(info.phone).toBe('+1 555 0101');
		expect(info.country).toBe('US');
	});

	describe('tidyWebsiteSection', () => {
		it('trims text, writes codes in capitals, puts the store currency and the default language first, once each', () => {
			const tidy = tidyWebsiteSection('region', {
				...full().region,
				country: ' us ',
				currency: 'eur',
				currencies: ['usd', 'EUR', 'usd'],
				language: ' fr-fr',
				languages: ['en-US', 'fr-FR', 'en-US'],
			});
			expect(tidy).toMatchObject({
				country: 'US',
				currency: 'EUR',
				currencies: ['EUR', 'USD'],
				language: 'fr-FR',
				languages: ['fr-FR', 'en-US'],
			});
		});

		it('keeps host names in lower case once, drops empty list entries and leaves unknown members for the validator to refuse', () => {
			expect(
				tidyWebsiteSection('pages', {
					hosts: [' WWW.Example.com ', 'www.example.com', ''],
					signIn: ' ',
					privacy: '',
					documents: [],
				}),
			).toEqual({
				hosts: ['www.example.com'],
				signIn: '',
				privacy: '',
				documents: [],
			});
			expect(tidyWebsiteSection('pages', { hosts: [], signIn: '', privacy: '', documents: [], oops: 1 })).toHaveProperty(
				'oops',
				1,
			);
		});

		it('is not mistaken by a value that is not an object', () => {
			expect(tidyWebsiteSection('business', null)).toBeNull();
			expect(tidyWebsiteSection('business', 'x')).toBe('x');
		});
	});

	describe('what a product needs (manifest websiteSettings.requires)', () => {
		it('lists the paths a product can ask for and finds what is still empty', () => {
			expect(WEBSITE_SETTINGS_PATHS).toContain('region.currency');
			expect(WEBSITE_SETTINGS_PATHS).toContain('business.name');
			expect(isWebsiteSettingsPath('region.timeZone')).toBe(true);
			expect(isWebsiteSettingsPath('region.moon')).toBe(false);
			expect(isWebsiteSettingsPath('version')).toBe(false);
			expect(missingWebsiteSettings(emptyWebsiteSettings(WEBSITE), ['region.currency', 'region.country'])).toEqual([
				'region.currency',
				'region.country',
			]);
			expect(missingWebsiteSettings(full(), ['region.currency', 'business.address.city', 'region.currencies'])).toEqual([]);
			const partial = full();
			partial.region.currencies = [];
			partial.business.address.city = '';
			expect(missingWebsiteSettings(partial, ['region.currency', 'business.address.city', 'region.currencies'])).toEqual([
				'business.address.city',
				'region.currencies',
			]);
		});

		it('reads a value by its path, tells its kind and its section of the Portal page', () => {
			expect(websiteSettingAt(full(), 'region.currency')).toBe(full().region.currency);
			expect(websiteSettingAt(full(), 'region.nothing')).toBeUndefined();
			expect(websiteSettingKind('region.language')).toBe('string');
			expect(websiteSettingKind('region.languages')).toBe('array');
			expect(websiteSettingKind('team.staffPush')).toBe('boolean');
			expect(websiteSettingKind('region.format.wholeUnits')).toBe('boolean');
			expect(websiteSettingKind('brand.theme.radius')).toBe('number');
			expect(websiteSettingKind('region.moon')).toBeNull();
			expect(websiteSectionOf('region.format.locale')).toBe('region');
			expect(websiteSectionOf('pages.signIn')).toBe('pages');
			expect([isUnsetWebsiteValue(''), isUnsetWebsiteValue([]), isUnsetWebsiteValue(false), isUnsetWebsiteValue(0)]).toEqual([
				true,
				true,
				false,
				false,
			]);
		});

		it('is accepted in a manifest as an optional member, and refused when it names something that is not a setting', () => {
			const ok = { ...manifest(), websiteSettings: { requires: ['region.currency', 'region.country'] } };
			expect(validateManifest(ok).ok).toBe(true);
			expect(validateManifest(manifest()).ok).toBe(true);
			const wrong = { ...manifest(), websiteSettings: { requires: ['region.currency', 'region.moon'] } };
			expectProblem(validateManifest(wrong), '/websiteSettings/requires/1');
			const twice = { ...manifest(), websiteSettings: { requires: ['region.currency', 'region.currency'] } };
			expectProblem(validateManifest(twice), '/websiteSettings/requires');
			const extra = { ...manifest(), websiteSettings: { requires: [], more: true } };
			expectProblem(validateManifest(extra), '/websiteSettings/more');
		});
	});
});

describe('settingsVersion in the status response', () => {
	it('is optional (a Portal that does not send it still validates) and a count when it is there', () => {
		expect(validateStatusResponse(statusResponse()).ok).toBe(true);
		expect(validateStatusResponse({ ...statusResponse(), settingsVersion: 0 }).ok).toBe(true);
		expect(validateStatusResponse({ ...statusResponse(), settingsVersion: 7 }).ok).toBe(true);
		expectProblem(validateStatusResponse({ ...statusResponse(), settingsVersion: -1 }), '/settingsVersion');
		expectProblem(validateStatusResponse({ ...statusResponse(), settingsVersion: 1.5 }), '/settingsVersion');
	});
});
