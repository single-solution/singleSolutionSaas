/**
 * Shared service context: the per-website `Site` (settings + repositories), the injected side effects (`Deps`), the
 * label helpers (status, method and delivery names from settings or strings, in the website's or the order's
 * language) and failure values.
 */
import { createTranslator } from '../core/strings.js';
import { catalogFor } from '../core/messages.js';
import { isPayOnDelivery, statusOf } from '../core/lifecycle.js';

/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 */

/**
 * @typedef {object} Deps
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} publish
 * @property {(record: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>} usage
 * @property {(entry: Record<string, unknown>) => Promise<unknown>} audit
 * @property {(websiteId: string, message: import('../adapters/messaging.js').OutboundMessage, options: { path: string }) => Promise<import('../adapters/messaging.js').SendResult>} send
 * @property {(prefix: string) => string} newId
 * @property {(prefix: string, text: string) => string} stableId
 * @property {(websiteId: string, key: string) => string} hashKey
 * @property {() => number} now
 * @property {Record<string, Record<string, string>>} strings
 * @property {{ warn?: Function, error?: Function } | undefined} [log]
 */

/** @typedef {{ type: 'staff' | 'api' | 'customer' | 'system', id: string | null }} Actor */

/**
 * @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }>, extensions?: Record<string, unknown> }} Failure
 */

/**
 * @param {string} reason
 * @param {string} [detail]
 * @param {{ errors?: Array<{ path: string, code: string }>, extensions?: Record<string, unknown> }} [extra]
 * @returns {Failure}
 */
export const fail = (reason, detail, extra = {}) => ({ ok: false, reason, ...(detail ? { detail } : {}), ...extra });

/**
 * @param {Array<{ path: string, code: string }>} errors
 * @returns {Failure}
 */
export const invalid = (errors) => fail('validation_failed', 'The request is not valid.', { errors });

/**
 * Labels in a language.
 * @param {Deps} deps
 * @param {Site} site
 * @param {string | null | undefined} [lang] the order's language, else the website's
 */
export const labelsFor = (deps, site, lang) => {
	const { lang: resolved, strings } = catalogFor(deps.strings, lang ?? site.settings.language);
	const t = createTranslator(strings);
	/** @param {string} key */
	const has = (key) => Object.hasOwn(strings, key);
	return {
		lang: resolved,
		strings,
		t,
		/** @param {string} status */
		statusLabel: (status) =>
			statusOf(site.settings.matrix, status)?.label ??
			(has(`orders.status.${status}`) ? t(`orders.status.${status}`) : status),
		/** @param {string | null | undefined} method */
		methodLabel: (method) => {
			if (!method) return '—';
			const known = site.settings.methods.find((m) => m.key === method);
			return known?.label ?? (has(`ledger.method.${method}`) ? t(`ledger.method.${method}`) : method);
		},
		/** @param {string | null | undefined} method */
		deliveryLabel: (method) => (!method ? '—' : has(`delivery.${method}`) ? t(`delivery.${method}`) : method),
	};
};

/**
 * The document context (`core/documents.js`) of a website.
 * @param {Deps} deps
 * @param {Site} site
 * @param {string | null | undefined} [lang]
 * @returns {import('../core/documents.js').DocContext}
 */
export const docContext = (deps, site, lang) => {
	const labels = labelsFor(deps, site, lang);
	const config = site.settings.invoices;
	return {
		t: labels.t,
		locale: labels.lang,
		timeZone: site.settings.timeZone,
		brand: {
			name: config.brand_name || site.settings.domain,
			logoUrl: typeof config.logo_url === 'string' && config.logo_url.startsWith('https://') ? config.logo_url : null,
			addressLines: config.address_lines,
			contactLines: config.contact_lines,
			taxId: config.tax_id || null,
			legalText: config.legal_text || null,
			footerText: config.footer_text || null,
		},
		statusLabel: labels.statusLabel,
		methodLabel: labels.methodLabel,
		deliveryLabel: labels.deliveryLabel,
		payOnDelivery: (order) => isPayOnDelivery(site.settings.matrix, /** @type {any} */ (order)),
		now: deps.now(),
	};
};
