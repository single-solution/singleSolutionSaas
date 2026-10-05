/**
 * The application: one composition of the capture service, the trigger engine and the outbox dispatcher over a
 * website's settings and repositories, shared by the routes, the event consumers, the hosted pages, the dashboard and
 * the scheduled job. Side effects come in through `Deps` (clock, ids, tokens, Portal events, usage, audit, messaging),
 * so every part is testable against the fake Portal and a fake provider.
 */
import { createHash } from 'node:crypto';
import { repositoriesFor } from '../adapters/db.js';
import { createMessenger } from '../adapters/messaging.js';
import { catalogText } from '../core/dispatch.js';
import { createCapture } from './capture.js';
import { createDispatcher } from './dispatcher.js';
import { createEngine } from './engine.js';
import { settingsForDoc } from './settings.js';

/**
 * @typedef {object} Site one website, as seen by a request, an event or the job
 * @property {string} websiteId
 * @property {any} doc signed entitlement document
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 * @property {string} domain the website's domain (entitlement)
 * @property {boolean} allowSubdomains
 */

/**
 * @typedef {object} Deps
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 * @property {(prefix: string, key: string) => string} stableId
 * @property {import('../adapters/tokens.js').Tokens} tokens
 * @property {Record<string, Record<string, string>>} strings
 * @property {(text: string) => string} hashText
 * @property {(lang: string) => string} consentText
 * @property {() => string} baseUrl the product's public origin (hosted pages)
 * @property {string} instanceId
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<void>} publish
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>} recordUsage
 * @property {(entry: Record<string, unknown>) => Promise<unknown>} audit
 * @property {ReturnType<typeof createMessenger>} send
 * @property {(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void} log
 */

/**
 * @param {import('../adapters/platform.js').AlertsApp} app
 */
export const createAlerts = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	/** @type {(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void} */
	const log = (level, message, fields = {}) => product.context?.logger?.[level]?.(message, fields);
	/** @type {Deps} */
	const deps = {
		now: app.now,
		newId: app.newId,
		stableId: app.stableId,
		tokens: app.tokens,
		strings: app.strings,
		hashText: (text) => createHash('sha256').update(text).digest('base64url').slice(0, 22),
		consentText: (lang) => catalogText('capture.consent', {}, { catalogs: app.strings, lang, defaultLang: 'en' }),
		baseUrl: () => String(product.manifest.endpoints.base).replace(/\/+$/, ''),
		instanceId: app.instanceId,
		publish: async (event) => {
			try {
				await product.portal.publishEvent(event);
			} catch (error) {
				log('warn', 'event publish failed', { type: event.type, error });
			}
		},
		recordUsage: (usage) => product.usage.record(usage),
		audit: async (entry) => {
			try {
				await product.audit.record(entry);
			} catch (error) {
				log('warn', 'audit failed', { action: entry.action, error });
			}
		},
		send: createMessenger(product),
		log,
	};
	const dispatcher = createDispatcher(deps);
	const engine = createEngine({ ...deps, dispatcher });
	const capture = createCapture({ ...deps, dispatcher });

	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		await app.registry.remember(websiteId);
		return {
			websiteId,
			doc,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
			domain: doc.domain,
			allowSubdomains: doc.allowSubdomains === true,
		};
	};

	/**
	 * Site of a website from its entitlement (null without an active subscription or with the base element off).
	 * @param {string} websiteId
	 * @param {{ element?: string }} [options] element that must be on (default the base element `types`)
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId, { element = 'types' } = {}) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, element)) return null;
		return siteOf(websiteId, result.doc);
	};

	return { app, product, deps, capture, engine, dispatcher, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createAlerts>} Alerts */
