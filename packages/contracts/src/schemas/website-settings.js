/**
 * The shape of the website-settings document (`ss.website-settings/1`; vocabulary, limits and the checks a schema
 * cannot make are in `../website-settings.js`). Every member is required: the Portal always writes the whole document,
 * with `''` for unset text and `[]` for an unset list.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';
import {
	ADDRESS_REQUIRED_PARTS,
	PHONE_CHANNELS,
	WEBSITE_SETTINGS_LIMITS as L,
	WEBSITE_SETTINGS_SCHEMA,
	WEBSITE_UNITS,
} from '../website-settings.js';
import { PLACE_LIMITS } from '../address.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** @param {number} max */
const text = (max) => ({ type: 'string', maxLength: max });
/** @param {number} max @param {string} pattern */
const matching = (max, pattern) => ({ type: 'string', maxLength: max, pattern });
/** @param {number} max */
const required = (max) => ({ type: 'string', minLength: 1, maxLength: max });
/** @param {object} items @param {number} max @param {number} [min] */
const list = (items, max, min = 0) => ({ type: 'array', minItems: min, maxItems: max, items });
/** @param {Record<string, object>} properties */
const shape = (properties) => ({
	type: 'object',
	required: Object.keys(properties),
	additionalProperties: false,
	properties,
});

const EMAIL = '^(?:[^\\s@]+@[^\\s@]+\\.[^\\s@]+)?$';
const PHONE = '^(?:\\+?[0-9 ().-]{3,40})?$';
const PHONE_SET = '^\\+?[0-9 ().-]{3,40}$';
const COUNTRY = '^(?:[A-Z]{2})?$';
const COUNTRY_SET = '^[A-Z]{2}$';
const CURRENCY = '^[A-Z]{3}$';
const LANGUAGE = '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$';
const TIME = '^(?:[01]\\d|2[0-3]):[0-5]\\d$';
const END = '^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$';
const HTTPS = '^https://\\S+$';

const email = matching(L.email, EMAIL);
const phone = matching(L.phone, PHONE);
const file = matching(L.url, `^(?:${HTTPS.slice(1, -1)})?$`);
const timeWindow = shape({ start: matching(5, TIME), end: matching(5, END) });

/** The website-settings document. */
export const websiteSettingsSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.websiteSettings,
	title: 'Website settings',
	...shape({
		schema: { const: WEBSITE_SETTINGS_SCHEMA },
		websiteId: ref('opaqueId'),
		version: ref('count'),
		updatedAt: { anyOf: [ref('timestamp'), { type: 'null' }] },
		business: shape({
			name: text(L.name),
			otherNames: list(required(L.shortName), L.otherNames),
			tagline: text(L.tagline),
			legalName: text(L.name),
			taxNumber: text(L.taxNumber),
			businessType: text(L.businessType),
			email,
			phone,
			phones: list(shape({ label: text(L.phoneLabel), number: matching(L.phone, PHONE_SET) }), L.phones),
			whatsapp: phone,
			address: shape({
				...Object.fromEntries(Object.entries(PLACE_LIMITS).map(([part, max]) => [part, text(max)])),
				country: matching(2, COUNTRY),
			}),
			hours: shape({
				weekly: list(
					shape({ day: { type: 'integer', minimum: 1, maximum: 7 }, start: matching(5, TIME), end: matching(5, END) }),
					L.weeklyWindows,
				),
				exceptions: list(
					shape({
						date: matching(10, '^\\d{4}-\\d{2}-\\d{2}$'),
						name: text(L.exceptionName),
						hours: list(timeWindow, L.windowsPerDay),
					}),
					L.exceptions,
				),
			}),
			social: list(shape({ label: required(L.socialLabel), url: matching(L.url, HTTPS) }), L.social),
		}),
		brand: shape({
			files: shape({
				logo: file,
				logoDark: file,
				icon: file,
				favicon: file,
				faviconDark: file,
				shareImage: file,
			}),
			theme: shape({
				mode: { enum: ['light', 'dark', 'auto'] },
				fontFamily: matching(64, '^(?:inherit|[A-Za-z0-9][A-Za-z0-9 _-]{0,63})$'),
				radius: { type: 'integer', minimum: 0, maximum: L.maxRadius },
				colors: {
					type: 'object',
					maxProperties: L.themeColors,
					propertyNames: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]{0,31}$' },
					additionalProperties: matching(7, '^#[0-9a-fA-F]{6}$'),
				},
				customCss: text(L.customCss),
			}),
		}),
		region: shape({
			country: matching(2, COUNTRY),
			timeZone: text(64),
			currency: matching(3, `^(?:${CURRENCY.slice(1, -1)})?$`),
			currencies: list(matching(3, CURRENCY), L.currencies),
			language: matching(35, `^(?:${LANGUAGE.slice(1, -1)})?$`),
			languages: list(matching(35, LANGUAGE), L.languages),
			countriesServed: list(matching(2, COUNTRY_SET), L.countries),
			units: shape({ weight: { enum: ['', ...WEBSITE_UNITS.weight] }, size: { enum: ['', ...WEBSITE_UNITS.size] } }),
			format: shape({
				locale: text(35),
				currencyDisplay: { enum: ['code', 'symbol'] },
				currencySymbols: {
					type: 'object',
					maxProperties: 20,
					propertyNames: { type: 'string', pattern: CURRENCY },
					additionalProperties: required(8),
				},
				wholeUnits: { type: 'boolean' },
				times: { enum: ['viewer', 'business'] },
			}),
			phone: shape({
				callingCode: matching(4, '^(?:\\+\\d{1,3})?$'),
				trunkPrefix: matching(2, '^\\d{0,2}$'),
				countries: list(matching(2, COUNTRY_SET), L.countries),
			}),
			address: shape({
				required: list({ enum: [...ADDRESS_REQUIRED_PARTS] }, ADDRESS_REQUIRED_PARTS.length),
				regions: list(
					shape({
						country: matching(2, COUNTRY_SET),
						names: list(required(L.regionName), L.regionNames, 1),
					}),
					L.regionCountries,
				),
			}),
		}),
		pages: shape({
			hosts: list(ref('hostname'), L.hosts),
			signIn: text(L.url),
			privacy: text(L.url),
			documents: list(
				shape({
					key: matching(L.documentKey, '^[a-z][a-z0-9_-]{1,39}$'),
					title: required(L.documentTitle),
					text: text(L.documentText),
				}),
				L.documents,
			),
		}),
		team: shape({
			recipients: list(shape({ name: text(L.recipientName), email, phone }), L.recipients),
			phoneChannel: { enum: ['', ...PHONE_CHANNELS] },
			staffPush: { type: 'boolean' },
			support: shape({ email, phone }),
		}),
	}),
});
