/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Growth's manifest
 * (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (the merchant database,
 * which the kit always adds, and the Accounts token for activity-log copies), the merchant database indexes (the raw
 * events' expiry index, the redirect rules and the SEO checklist's kept report included), the page script's settings, what the `import` feature takes and its part of the
 * website Setup sheet (the OpenAPI document, the guide's "What your website builds" per feature, the tags that are on
 * with how they wait for consent, and the number of redirect rules), and adds the web calls (SEO checklist, IndexNow)
 * on the same outbound policy. The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct, createProductBase } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import consentBanner from '../schemas/consent_banner.settings.json' with { type: 'json' };
import conversionFunnel from '../schemas/conversion_funnel.settings.json' with { type: 'json' };
import customScripts from '../schemas/custom_scripts.settings.json' with { type: 'json' };
import googleTags from '../schemas/google_tags.settings.json' with { type: 'json' };
import indexnow from '../schemas/indexnow.settings.json' with { type: 'json' };
import metaPixel from '../schemas/meta_pixel.settings.json' with { type: 'json' };
import noticeBar from '../schemas/notice_bar.settings.json' with { type: 'json' };
import redirects from '../schemas/redirects.settings.json' with { type: 'json' };
import robotsVerification from '../schemas/robots_verification.settings.json' with { type: 'json' };
import searches404s from '../schemas/searches_404s.settings.json' with { type: 'json' };
import seoChecklist from '../schemas/seo_checklist.settings.json' with { type: 'json' };
import tiktokPixel from '../schemas/tiktok_pixel.settings.json' with { type: 'json' };
import visitorAnalytics from '../schemas/visitor_analytics.settings.json' with { type: 'json' };
import webVitals from '../schemas/web_vitals.settings.json' with { type: 'json' };
import importSettings from '../schemas/import.settings.json' with { type: 'json' };
import tagsShared from '../schemas/tags.shared.json' with { type: 'json' };
import pixelsShared from '../schemas/pixels.shared.json' with { type: 'json' };
import { widgetSettings } from '../core/config.js';
import { createImportOptions } from './imports.js';
import { REDIRECT_INDEXES, createRedirectStore } from './redirects.js';
import { SEO_REPORT_INDEXES } from './seo-reports.js';
import { INDEXES } from './store.js';
import { createWeb } from './web.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	meta_pixel: metaPixel,
	google_tags: googleTags,
	tiktok_pixel: tiktokPixel,
	custom_scripts: customScripts,
	consent_banner: consentBanner,
	visitor_analytics: visitorAnalytics,
	conversion_funnel: conversionFunnel,
	searches_404s: searches404s,
	web_vitals: webVitals,
	robots_verification: robotsVerification,
	indexnow,
	seo_checklist: seoChecklist,
	redirects,
	notice_bar: noticeBar,
	import: importSettings,
};

/** The features that load tags once the visitor consents (they share the Tags and consent settings). */
const TAG_FEATURES = ['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'];

/**
 * Settings several features use, stored once as `<group>.<setting>` and shown while any of their features is on
 * (PLAN 0.8.10 G1, G2): whether the tags wait for consent, and which item ids the pixels get.
 * @type {Record<string, { name: string, features: string[], settings: any }>}
 */
export const SHARED_SETTINGS = {
	tags: { name: 'Tags and consent', features: TAG_FEATURES, settings: tagsShared },
	pixels: { name: 'Pixel events', features: ['meta_pixel', 'google_tags', 'tiktok_pixel'], settings: pixelsShared },
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** Growth's own problem codes. */
const PROBLEM_CODES = Object.freeze({
	indexnow_refused: Object.freeze({ status: 502, title: 'IndexNow refused the submission' }),
	redirect_taken: Object.freeze({ status: 409, title: 'Another rule has this path' }),
	redirect_loop: Object.freeze({ status: 409, title: 'The rules would make a redirect loop' }),
	redirect_chain: Object.freeze({ status: 409, title: 'The rules would make a redirect chain' }),
	redirects_full: Object.freeze({ status: 409, title: 'The website has the most rules it may have' }),
});

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes' | 'imports' | 'sharedSettings' | 'openapi' | 'build'>
 *   & { data?: { createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => import('mongodb').MongoClient } }} InstanceOptions
 *   `data.createClient`: the merchant database client factory (tests watch its commands)
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its web calls.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	// the kit's store and outbound send (the policy for addresses merchants enter), shared with createProduct
	const { store, send } = createProductBase(options);
	const web = createWeb({ send });

	/**
	 * The settings of each switched-on feature, and of each shared group one of them uses.
	 * @param {string} websiteId
	 * @param {ReadonlyArray<string>} on
	 */
	const valuesOf = async (websiteId, on) => {
		const groups = Object.entries(SHARED_SETTINGS)
			.filter(([, group]) => group.features.some((feature) => on.includes(feature)))
			.map(([key]) => key);
		return Object.fromEntries(
			await Promise.all([...on, ...groups].map(async (key) => [key, await product.settings.values(websiteId, key)])),
		);
	};

	/**
	 * How many redirect rules a website has (one count in the merchant database), or null when the database is not
	 * connected or the count fails.
	 * @param {string} websiteId
	 * @param {string} merchantId
	 */
	const redirectCount = async (websiteId, merchantId) => {
		try {
			const rules = createRedirectStore(await product.data.forWebsite(websiteId, { merchantId }), { merchantId });
			const { collection, filter } = rules.countSource({});
			return /** @type {number} */ (await collection.countDocuments(filter));
		} catch {
			return null;
		}
	};

	/**
	 * Growth's own part of the website Setup sheet: the tags that are on and how they wait for the visitor's consent
	 * (the guide's consent section), and the number of redirect rules while Redirects is on and the count can be had.
	 * Never a secret.
	 * @param {{ websiteId: string, merchantId: string, on: string[] }} website
	 * @returns {Promise<{ summaries: Array<{ title: string, text: string }> }>}
	 */
	const setupPart = async ({ websiteId, merchantId, on }) => {
		const tags = manifest.features.filter((feature) => TAG_FEATURES.includes(feature.key) && on.includes(feature.key));
		const [consentRequired, rules] = await Promise.all([
			tags.length > 0 ? product.settings.values(websiteId, 'tags').then((values) => values.consentRequired !== false) : true,
			on.includes('redirects') ? redirectCount(websiteId, merchantId) : null,
		]);
		const waiting = !consentRequired
			? "They load at once, with Google Consent Mode granted, until the visitor chooses: 'Tags wait for the visitor's consent' is off (Settings → Tags and consent)."
			: on.includes('consent_banner')
				? 'The consent banner asks visitors first.'
				: "The consent banner is off, so they wait until your own consent tool passes the visitor's choice on with SSGrowth.consent.set().";
		return {
			summaries: [
				{
					title: 'Tags after consent',
					text:
						tags.length > 0 ? `${tags.map((feature) => feature.name).join(', ')}. ${waiting}` : 'No marketing tags are on.',
				},
				...(rules === null
					? []
					: [{ title: 'Redirects', text: `${rules.toLocaleString('en-US')} ${rules === 1 ? 'rule' : 'rules'}.` }]),
			],
		};
	};

	const product = createProduct({
		...options,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			accounts: { label: 'Accounts token (activity-log copies)', kind: 'token', productId: 'accounts', neededBy: [] },
		},
		hooks: {
			// what the page script and the widgets need (GET /v1/widget/config): never a secret
			widgetConfig: async (ctx) => {
				const websiteId = /** @type {string} */ (ctx.websiteId);
				const on = await product.featuresOn(websiteId);
				// the admin widgets (ticket) also get the checklist's pages, the IndexNow key file and the raw events' keep time
				const admin = ctx.ticket ? { domain: String(ctx.status?.domain ?? '') } : null;
				return widgetSettings({ on, values: await valuesOf(websiteId, on), now: now(), admin });
			},
			blueprint: setupPart,
		},
		data: {
			indexes: [...INDEXES, ...REDIRECT_INDEXES, ...SEO_REPORT_INDEXES],
			...(options.data?.createClient ? { createClient: options.data.createClient } : {}),
		},
		// days of daily totals moved in from another system with ss-import (feature `import`, PLAN 0.8.10 K10)
		imports: createImportOptions(),
		sharedSettings: SHARED_SETTINGS,
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
	});
	return Object.freeze({ ...product, web, now, valuesOf });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
