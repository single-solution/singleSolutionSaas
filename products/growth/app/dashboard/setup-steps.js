/**
 * What a Growth website still has to set, as the setup checklist of the Overview (owner 2026-10-17): the ids, keys and
 * addresses the switched-on features need, each with one plain line on why and a button to the exact section of
 * Settings. Accounts' token comes from the manifest's `neededBy`, so no connection is listed here.
 * @module
 */
import { isFilled } from '@ss/ui/dashboard';

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'meta-pixel',
		when: ['meta_pixel'],
		setting: 'meta_pixel.pixelId',
		label: 'Add your Meta pixel id',
		why: 'The Meta pixel loads nothing on your pages until its id is set.',
		action: 'Add id',
	},
	{
		key: 'google-tags',
		when: ['google_tags'],
		setting: 'google_tags.ga4Id',
		done: (/** @type {unknown} */ _value, /** @type {{ values: Record<string, unknown> }} */ { values }) =>
			['ga4Id', 'adsId', 'gtmId'].some((name) => isFilled(values[name])),
		label: 'Add a Google tag id',
		why: 'Google Analytics, Google Ads and Tag Manager load nothing until at least one id is set.',
		action: 'Add id',
	},
	{
		key: 'tiktok-pixel',
		when: ['tiktok_pixel'],
		setting: 'tiktok_pixel.pixelId',
		label: 'Add your TikTok pixel id',
		why: 'The TikTok pixel loads nothing on your pages until its id is set.',
		action: 'Add id',
	},
	{
		key: 'privacy-link',
		when: ['consent_banner'],
		setting: 'consent_banner.privacyUrl',
		label: 'Link your privacy policy',
		why: 'The consent banner sends visitors to your privacy policy, so they know what they agree to.',
		action: 'Set link',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'indexnow-key',
		when: ['indexnow'],
		setting: 'indexnow.key',
		done: (/** @type {unknown} */ value, /** @type {{ values: Record<string, unknown> }} */ { values }) =>
			isFilled(value) && isFilled(values.keyPath),
		label: 'Set your IndexNow key',
		why: 'Search engines hear about changed pages only with a key that your website serves as a text file.',
		action: 'Set key',
	},
]);
