'use client';
/**
 * What the dashboard tells about a website's setup, from its settings only (PLAN 0.4.3: setup, never business data):
 * the notes above a settings card (the law warning while tags need no consent, PLAN 0.8.10 G1; tag ids that are not
 * loaded; what robots.txt, the verification tags and the IndexNow key file serve, G4 and G5; the notice bar turned off, G4;
 * Web Vitals to Google Analytics without Google tags, G7, and without Visitor analytics, SG-27).
 * @module
 */
import { Badge, Callout, CodeBlock } from '@ss/ui';
import { fill } from '@ss/ui/dashboard';
import { tagsOf } from '../../core/config.js';
import { keyLocationOf, robotsTxtOf, verificationOf } from '../../core/seo.js';
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
