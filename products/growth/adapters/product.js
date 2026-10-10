/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Growth's manifest
 * (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (the merchant database,
 * which the kit always adds, and the Accounts token for activity-log copies), the merchant database indexes (the raw
 * events' expiry index included) and the page script's settings, and adds the web calls (SEO checklist, IndexNow) on
 * the same outbound policy. The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import consentBanner from '../schemas/consent_banner.settings.json' with { type: 'json' };
import conversionFunnel from '../schemas/conversion_funnel.settings.json' with { type: 'json' };
import customScripts from '../schemas/custom_scripts.settings.json' with { type: 'json' };
import googleTags from '../schemas/google_tags.settings.json' with { type: 'json' };
import indexnow from '../schemas/indexnow.settings.json' with { type: 'json' };
import metaPixel from '../schemas/meta_pixel.settings.json' with { type: 'json' };
import noticeBar from '../schemas/notice_bar.settings.json' with { type: 'json' };
import robotsVerification from '../schemas/robots_verification.settings.json' with { type: 'json' };
import searches404s from '../schemas/searches_404s.settings.json' with { type: 'json' };
import seoChecklist from '../schemas/seo_checklist.settings.json' with { type: 'json' };
import tiktokPixel from '../schemas/tiktok_pixel.settings.json' with { type: 'json' };
import visitorAnalytics from '../schemas/visitor_analytics.settings.json' with { type: 'json' };
import webVitals from '../schemas/web_vitals.settings.json' with { type: 'json' };
import tagsShared from '../schemas/tags.shared.json' with { type: 'json' };
import pixelsShared from '../schemas/pixels.shared.json' with { type: 'json' };
import { widgetSettings } from '../core/config.js';
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
	notice_bar: noticeBar,
};

/**
 * Settings several features use, stored once as `<group>.<setting>` and shown while any of their features is on
 * (PLAN 0.8.10 G1, G2): whether the tags wait for consent, and which item ids the pixels get.
 * @type {Record<string, { name: string, features: string[], settings: any }>}
 */
export const SHARED_SETTINGS = {
	tags: {
		name: 'Tags and consent',
		features: ['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'],
		settings: tagsShared,
	},
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
});

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes'>} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its web calls.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	// the same policy the kit uses for addresses merchants enter
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {import('./web.js').OutboundSend} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
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

	const product = createProduct({
		...options,
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
				// the admin widgets (ticket) also get the checklist's pages, the IndexNow key file and the analytics detail
				const admin = ctx.ticket ? { domain: String(ctx.status?.domain ?? '') } : null;
				return widgetSettings({ on, values: await valuesOf(websiteId, on), now: now(), admin });
			},
		},
		data: { indexes: INDEXES },
		sharedSettings: SHARED_SETTINGS,
	});
	return Object.freeze({ ...product, web, now, valuesOf });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
