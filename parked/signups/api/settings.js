/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and list the product uses comes
 * from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import accountPages from '../schemas/account_pages.features.json' with { type: 'json' };
import consent from '../schemas/consent.features.json' with { type: 'json' };
import dataRights from '../schemas/data_rights.features.json' with { type: 'json' };
import magicLink from '../schemas/magic_link.features.json' with { type: 'json' };
import otp from '../schemas/otp.features.json' with { type: 'json' };
import profile from '../schemas/profile.features.json' with { type: 'json' };
import risk from '../schemas/risk.features.json' with { type: 'json' };
import sessions from '../schemas/sessions.features.json' with { type: 'json' };
import widget from '../schemas/widget.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	profile,
	sessions,
	otp,
	magic_link: magicLink,
	account_pages: accountPages,
	widget,
	risk,
	consent,
	data_rights: dataRights,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {Record<string, any>} profile
 * @property {Record<string, any>} sessions
 * @property {Record<string, any>} otp
 * @property {Record<string, any>} magicLink
 * @property {Record<string, any>} accountPages
 * @property {Record<string, any>} widget
 * @property {Record<string, any> | null} risk null when the element is off
 * @property {{ documents: import('../core/consent.js').ConsentDocument[], require_reacceptance: boolean } | null} consent
 * @property {Record<string, any> | null} dataRights
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	return {
		enabled,
		profile: of('profile'),
		sessions: of('sessions'),
		otp: of('otp'),
		magicLink: of('magic_link'),
		accountPages: of('account_pages'),
		widget: of('widget'),
		risk: enabled('risk') ? of('risk') : null,
		consent: enabled('consent') ? /** @type {any} */ (of('consent')) : null,
		dataRights: enabled('data_rights') ? of('data_rights') : null,
	};
};

/**
 * Settings from a signed entitlement document through the app-kit helpers.
 * @param {any} product app-kit product
 * @param {any} doc entitlement document
 * @returns {Settings}
 */
export const settingsForDoc = (product, doc) =>
	settingsFrom({
		can: (key) => product.entitlements.can(doc, key),
		config: (key) => product.entitlements.config(doc, key) ?? {},
	});
