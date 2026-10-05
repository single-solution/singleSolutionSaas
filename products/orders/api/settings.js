/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration (the
 * feature schemas' defaults overlaid with the document's values), plus the website's own settings from the Portal
 * (domain, currency, language, time zone). Every status, number, flag and list the product uses comes from here.
 */
import { effectiveConfig } from '../core/config.js';
import { carriersOf } from '../core/fulfilment.js';
import { createMatrix } from '../core/lifecycle.js';
import { methodsOf } from '../core/ledger.js';
import { mappingsOf } from '../core/mapping.js';
import { rulesOf } from '../core/serials.js';
import bulk from '../schemas/bulk.features.json' with { type: 'json' };
import customerUpdates from '../schemas/customer_updates.features.json' with { type: 'json' };
import fulfilment from '../schemas/fulfilment.features.json' with { type: 'json' };
import inboundApi from '../schemas/inbound_api.features.json' with { type: 'json' };
import invoices from '../schemas/invoices.features.json' with { type: 'json' };
import ledger from '../schemas/ledger.features.json' with { type: 'json' };
import lifecycle from '../schemas/lifecycle.features.json' with { type: 'json' };
import print from '../schemas/print.features.json' with { type: 'json' };
import risk from '../schemas/risk.features.json' with { type: 'json' };
import serials from '../schemas/serials.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	lifecycle,
	fulfilment,
	serials,
	invoices,
	print,
	bulk,
	risk,
	customer_updates: customerUpdates,
	ledger,
	inbound_api: inboundApi,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */
export const ELEMENTS = /** @type {ElementKey[]} */ (Object.keys(SCHEMAS));

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} domain
 * @property {string | null} currency the website's currency (orders carry their own)
 * @property {string} language
 * @property {string | null} timeZone
 * @property {Record<string, any>} lifecycle
 * @property {Record<string, any>} fulfilment
 * @property {Record<string, any>} serials
 * @property {Record<string, any>} invoices
 * @property {Record<string, any>} print
 * @property {Record<string, any>} bulk
 * @property {import('../core/risk.js').RiskSettings & Record<string, any>} risk
 * @property {Record<string, any>} updates
 * @property {Record<string, any>} ledger
 * @property {Record<string, any>} inbound
 * @property {import('../core/lifecycle.js').Matrix} matrix
 * @property {import('../core/fulfilment.js').Carrier[]} carriers
 * @property {import('../core/serials.js').SerialRule[]} serialRules
 * @property {import('../core/ledger.js').Method[]} methods
 * @property {import('../core/mapping.js').Mapping[]} mappings
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   domain: string, website?: { currency?: string, language?: string, timeZone?: string } | null }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config, domain, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const lifecycleSettings = of('lifecycle');
	const fulfilmentSettings = of('fulfilment');
	const serialSettings = of('serials');
	const ledgerSettings = of('ledger');
	const inbound = of('inbound_api');
	return {
		enabled: (key) => can(key),
		domain,
		currency: website?.currency ?? null,
		language: website?.language ?? 'en',
		timeZone: website?.timeZone ?? null,
		lifecycle: lifecycleSettings,
		fulfilment: fulfilmentSettings,
		serials: serialSettings,
		invoices: of('invoices'),
		print: of('print'),
		bulk: of('bulk'),
		risk: /** @type {Settings['risk']} */ (of('risk')),
		updates: of('customer_updates'),
		ledger: ledgerSettings,
		inbound,
		matrix: createMatrix(lifecycleSettings),
		carriers: carriersOf(fulfilmentSettings.carriers),
		serialRules: rulesOf(serialSettings.rules),
		methods: methodsOf(ledgerSettings.methods),
		mappings: mappingsOf(inbound.mappings),
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
		domain: doc.domain,
		website: doc.website ?? null,
	});
