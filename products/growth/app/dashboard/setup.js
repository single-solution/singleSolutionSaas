'use client';
/**
 * What the dashboard tells about a website's setup, from its settings only (PLAN 0.4.3: setup, never business data):
 * the notes above a settings card (the law warning while tags need no consent, PLAN 0.8.10 G1; tag ids that are not
 * loaded; what robots.txt, the verification tags and the IndexNow key file serve, G4 and G5; the notice bar turned off, G4;
 * Web Vitals to Google Analytics without Google tags, G7, and without Visitor analytics, SG-27) and Overview's setup at
 * a glance.
 * @module
 */
import { Badge, Callout, Card, CodeBlock, KeyValueList, Masonry, Section } from '@ss/ui';
import { fill } from '@ss/ui/dashboard';
import { tagsOf } from '../../core/config.js';
import { aiCrawlersOf, keyLocationOf, robotsTxtOf, sitemapUrlsOf, verificationOf } from '../../core/seo.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, Record<string, unknown>>} Values settings by feature or shared group */
/**
 * @typedef {{ on: string[], domain: string, now: number, timeZone?: string | undefined, searchParams?: string[] }} Context
 *   the switched-on features, the domain, the time, the viewer's time zone (UTC without it: on the server and in the
 *   first render) and the search parameters of Searches and 404s (robots.txt keeps their result pages out)
 */

/** The tag id settings of each tag feature, with the tag they load. @type {Record<string, Array<[string, string]>>} */
const TAG_FIELDS = {
	meta_pixel: [['pixelId', 'meta']],
	google_tags: [
		['ga4Id', 'ga4'],
		['adsId', 'ads'],
		['adsPurchaseLabel', 'adsPurchaseLabel'],
		['gtmId', 'gtm'],
	],
	tiktok_pixel: [['pixelId', 'tiktok']],
};

/**
 * The tag ids a merchant typed that are not well formed, so are not loaded.
 * @param {string} key
 * @param {Record<string, unknown>} values
 */
const malformedIds = (key, values) => {
	const fields = TAG_FIELDS[key];
	if (!fields) return [];
	const tags = /** @type {Record<string, unknown>} */ (tagsOf([key], { [key]: values }));
	return fields
		.filter(
			([setting, tag]) => typeof values[setting] === 'string' && String(values[setting]).trim() !== '' && tags[tag] === null,
		)
		.map(([setting]) => setting);
};

/**
 * What a settings card says above its form, from the values shown (edits included).
 * @param {string} key the feature or shared group
 * @param {Record<string, unknown>} values
 * @param {Context | null} context null on Defaults (no website)
 * @returns {import('react').ReactNode}
 */
export const settingsNotice = (key, values, context) => {
	/** @type {import('react').ReactNode[]} */
	const notes = [];
	if (key === 'tags' && values.consentRequired === false)
		notes.push(
			<Callout key="law" tone="warning">
				{TEXTS.settings.consentWarning}
			</Callout>,
		);
	const bad = malformedIds(key, values);
	if (bad.length > 0)
		notes.push(
			<Callout key="ids" tone="warning">
				{fill(TEXTS.setup.malformed, { fields: bad.join(', ') })}
			</Callout>,
		);
	if (key === 'google_tags' && values.ga4ViaGtm === true && !tagsOf(['google_tags'], { google_tags: values }).gtm)
		notes.push(
			<Callout key="gtm" tone="warning">
				{TEXTS.settings.gtmMissing}
			</Callout>,
		);
	if (key === 'web_vitals' && values.toGa4 === true && context && !context.on.includes('google_tags'))
		notes.push(
			<Callout key="ga4" tone="info">
				{TEXTS.setup.vitalsNoGoogle}
			</Callout>,
		);
	if (key === 'web_vitals' && context && !context.on.includes('visitor_analytics'))
		notes.push(
			<Callout key="kept" tone={values.toGa4 === true ? 'info' : 'warning'}>
				{values.toGa4 === true ? TEXTS.setup.vitalsGa4Only : TEXTS.setup.vitalsNowhere}
			</Callout>,
		);
	if (context && key === 'robots_verification') {
		const tags = verificationOf(values);
		notes.push(
			<div key="robots" className="space-y-2">
				<p className="text-sm text-muted">{fill(TEXTS.setup.robotsPreview, { domain: context.domain })}</p>
				<CodeBlock code={robotsTxtOf(values, context.domain, context.searchParams ?? [])} />
				<p className="text-sm text-muted">{TEXTS.setup.tagsPreview}</p>
				<CodeBlock code={tags.html || TEXTS.setup.noTags} />
			</div>,
		);
	}
	if (context && key === 'indexnow') {
		const location = keyLocationOf({ key: values.key, keyPath: values.keyPath }, context.domain);
		notes.push(
			location === null ? (
				<Callout key="key" tone="danger">
					{TEXTS.setup.keyPathBad}
				</Callout>
			) : (
				<Callout key="key" tone="info">
					{fill(TEXTS.setup.keyAt, { url: location, key: String(values.key || TEXTS.setup.yourKey) })}
				</Callout>
			),
		);
	}
	if (context && key === 'notice_bar' && values.enabled === false)
		notes.push(
			<p key="notice" className="flex flex-wrap items-center gap-2 text-sm">
				<Badge tone="neutral" dot>
					{TEXTS.setup.noticeOff}
				</Badge>
			</p>,
		);
	return notes.length > 0 ? <div className="mb-4 space-y-3">{notes}</div> : null;
};

/**
 * Yes or no as a badge.
 * @param {boolean} yes @param {string} [yesText] @param {string} [noText]
 */
const flag = (yes, yesText = TEXTS.setup.yes, noText = TEXTS.setup.no) => (
	<Badge tone={yes ? 'success' : 'neutral'} dot>
		{yes ? yesText : noText}
	</Badge>
);

/**
 * Overview's setup at a glance: a card per area of the switched-on features, from their settings.
 * @param {{ values: Values, context: Context }} props
 */
export function AtAGlance({ values, context }) {
	const { on, domain } = context;
	const tags = tagsOf(on, values);
	const cards = [];
	const tagFeatures = ['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'].filter((key) => on.includes(key));
	if (tagFeatures.length > 0 || on.includes('consent_banner'))
		cards.push(
			<Card key="tags" title={TEXTS.setup.tagsTitle}>
				<KeyValueList
					columns={1}
					items={[
						{
							label: TEXTS.setup.consent,
							value: tags.consentRequired ? (
								flag(true, TEXTS.setup.waits)
							) : (
								<Badge tone="warning" dot>
									{TEXTS.setup.noWait}
								</Badge>
							),
						},
						{ label: TEXTS.setup.banner, value: flag(on.includes('consent_banner'), TEXTS.setup.on, TEXTS.setup.ownTool) },
						...(on.includes('meta_pixel')
							? [{ label: 'Meta', value: flag(tags.meta !== null, TEXTS.setup.set, TEXTS.setup.notSet) }]
							: []),
						...(on.includes('google_tags')
							? [
									{
										label: 'Google Analytics 4',
										value: tags.ga4ViaGtm
											? flag(tags.gtm !== null, TEXTS.setup.viaGtm, TEXTS.setup.notSet)
											: flag(tags.ga4 !== null, TEXTS.setup.set, TEXTS.setup.notSet),
									},
									{ label: 'Google Ads', value: flag(tags.ads !== null, TEXTS.setup.set, TEXTS.setup.notSet) },
									{ label: 'Tag Manager', value: flag(tags.gtm !== null, TEXTS.setup.set, TEXTS.setup.notSet) },
								]
							: []),
						...(on.includes('tiktok_pixel')
							? [{ label: 'TikTok', value: flag(tags.tiktok !== null, TEXTS.setup.set, TEXTS.setup.notSet) }]
							: []),
						...(on.some((key) => ['meta_pixel', 'google_tags', 'tiktok_pixel'].includes(key))
							? [{ label: TEXTS.setup.itemIds, value: TEXTS.setup.ids[tags.contentIds] }]
							: []),
					]}
				/>
			</Card>,
		);
	if (on.includes('visitor_analytics')) {
		const analytics = values.visitor_analytics ?? {};
		cards.push(
			<Card key="analytics" title={TEXTS.setup.analyticsTitle}>
				<KeyValueList
					columns={1}
					items={[
						{
							label: TEXTS.setup.detail,
							value: analytics.detail === 'sessions' ? TEXTS.setup.sessions : TEXTS.setup.anonymous,
						},
						{ label: TEXTS.setup.afterConsent, value: flag(analytics.requireConsent !== false) },
						{ label: TEXTS.setup.country, value: flag(analytics.recordCountry !== false) },
						{
							label: TEXTS.setup.retention,
							value: fill(TEXTS.setup.months, { months: Number(analytics.retentionMonths) || 13 }),
						},
						{
							label: TEXTS.setup.recorded,
							value:
								['conversion_funnel', 'searches_404s', 'web_vitals']
									.filter((key) => on.includes(key))
									.map((key) => TEXTS.setup.parts[/** @type {'web_vitals'} */ (key)])
									.join(', ') || TEXTS.setup.visitsOnly,
						},
						...(on.includes('web_vitals')
							? [{ label: TEXTS.setup.vitalsToGa4, value: flag(values.web_vitals?.toGa4 === true) }]
							: []),
					]}
				/>
			</Card>,
		);
	}
	if (on.some((key) => ['robots_verification', 'indexnow', 'seo_checklist'].includes(key))) {
		const robots = values.robots_verification ?? {};
		const verified = verificationOf(robots).tags.map((tag) => tag.name);
		const location = keyLocationOf({ key: values.indexnow?.key, keyPath: values.indexnow?.keyPath }, domain);
		const paths = values.seo_checklist?.paths;
		cards.push(
			<Card key="seo" title={TEXTS.setup.seoTitle}>
				<KeyValueList
					columns={1}
					items={[
						...(on.includes('robots_verification')
							? [
									{
										label: TEXTS.setup.aiCrawlers,
										value: flag(
											aiCrawlersOf(robots).length > 0,
											fill(TEXTS.setup.blocked, { count: aiCrawlersOf(robots).length }),
											TEXTS.setup.allowed,
										),
									},
									{
										label: TEXTS.setup.sitemaps,
										value: String(sitemapUrlsOf(robots, domain).length),
									},
									{
										label: TEXTS.setup.verification,
										value: verified.length > 0 ? verified.join(', ') : TEXTS.setup.none,
									},
								]
							: []),
						...(on.includes('indexnow')
							? [
									{
										label: TEXTS.setup.indexnow,
										value: /^[A-Za-z0-9-]{8,128}$/.test(String(values.indexnow?.key ?? ''))
											? (location ?? TEXTS.setup.keyPathBad)
											: TEXTS.setup.noKey,
									},
								]
							: []),
						...(on.includes('seo_checklist')
							? [
									{
										label: TEXTS.setup.checklist,
										value: fill(TEXTS.setup.pages, {
											count: 1 + (Array.isArray(paths) ? paths.filter((path) => path !== '/').length : 0),
										}),
									},
								]
							: []),
					]}
				/>
			</Card>,
		);
	}
	if (cards.length === 0) return null;
	return (
		<Section title={TEXTS.setup.title} description={TEXTS.setup.help}>
			<Masonry>{cards}</Masonry>
		</Section>
	);
}
