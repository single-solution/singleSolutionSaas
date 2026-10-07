/**
 * The application: one composition of the list operations, guests, share links and the price-drop hook over a
 * website's settings and repositories, shared by the routes, the event consumers and the dashboard. Side effects come
 * in through the app (clock, ids, tokens, Portal events), so every part is testable against the fake Portal.
 */
import { repositoriesFor } from '../adapters/db.js';
import { createTranslator } from '../core/text.js';
import { createLists, failure } from './lists.js';
import { resolveOwner } from './owner.js';
import { settingsForDoc } from './settings.js';
import { createShares } from './shares.js';
import { createSignals } from './signals.js';

/** @typedef {import('./lists.js').Site} Site */

/**
 * The catalog of a language: exact, then its base language, then English.
 * @param {Record<string, Record<string, string>>} catalogs
 * @param {string} lang
 */
export const catalogFor = (catalogs, lang) => catalogs[lang] ?? catalogs[lang.split('-')[0] ?? ''] ?? catalogs.en ?? {};

/**
 * @param {import('../adapters/platform.js').WishlistApp} app
 */
export const createWishlist = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	/** @type {(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void} */
	const log = (level, message, fields = {}) => product.context?.logger?.[level]?.(message, fields);
	const deps = {
		now: app.now,
		newId: app.newId,
		tokens: app.tokens,
		/** @param {{ websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }} event */
		publish: async (event) => {
			try {
				await product.portal.publishEvent(event);
			} catch (error) {
				log('warn', 'event publish failed', { type: event.type, error });
			}
		},
		log,
	};
	const lists = createLists(deps);
	const shares = createShares({ now: app.now, tokens: app.tokens, lists });
	const signals = createSignals(deps);

	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		const lang = typeof doc.website?.language === 'string' ? doc.website.language : 'en';
		const t = createTranslator(catalogFor(app.strings, lang));
		return {
			websiteId,
			doc,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
			domain: typeof doc.domain === 'string' ? doc.domain : null,
			allowSubdomains: doc.allowSubdomains === true,
			lang,
			text: (key) => t(key),
		};
	};

	/**
	 * Site of a website from its entitlement (null without an active subscription or with the element off).
	 * @param {string} websiteId
	 * @param {{ element?: string }} [options] element that must be on (default `lists`)
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId, { element = 'lists' } = {}) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, element)) return null;
		return siteOf(websiteId, result.doc);
	};

	/**
	 * A guest token for a new guest (or a renewed one for a known guest).
	 * @param {Site} site
	 * @param {string} [guestId]
	 */
	const guestToken = (site, guestId) => {
		const issued = app.tokens.issueGuest({ websiteId: site.websiteId, guestId, ttlDays: site.settings.guests.ttlDays });
		return { token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() };
	};

	/**
	 * What the widgets need in one call: who the shopper is, their lists with items and the settings that shape the UI.
	 * A signed-in shopper who still holds a guest token gets the guest lists merged first (and is told to drop the
	 * token); a new visitor gets a guest token when guest lists are on; a guest token past half its life is renewed.
	 * @param {Site} site
	 * @param {any} ctx request context (website key, identity, body)
	 * @returns {Promise<import('./lists.js').Outcome>}
	 */
	const state = async (site, ctx) => {
		const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
		const guestsOn = site.settings.enabled('guest_merge');
		const resolved = resolveOwner({ ctx, site, tokens: app.tokens });
		/** @type {{ token: string, expiresAt: string } | null} */
		let guest = null;
		let merged = 0;
		let dropGuest = false;
		/** @type {import('../adapters/db.js').Owner | null} */
		let owner = null;
		if (resolved.ok) {
			owner = resolved.owner;
			if (owner?.kind === 'customer' && !resolved.server && body.guest !== undefined) {
				dropGuest = true;
				const from = guestsOn ? app.tokens.verifyGuest(body.guest, site.websiteId) : null;
				if (from) {
					const outcome = await lists.merge(site, owner, { kind: 'guest', id: from.guestId });
					if (outcome.ok) merged = outcome.body.merged;
				}
			} else if (owner?.kind === 'guest') {
				const held = app.tokens.verifyGuest(body.guest, site.websiteId);
				const halfLife = (site.settings.guests.ttlDays * 86_400_000) / 2;
				if (held && held.expiresAt - app.now() < halfLife) guest = guestToken(site, owner.id);
			}
		} else if (resolved.code === 'guest_invalid' || resolved.code === 'identity_required') {
			if (guestsOn && ctx.website?.kind === 'pk') {
				guest = guestToken(site);
				dropGuest = resolved.code === 'guest_invalid';
			}
		} else return resolved;
		const signedIn = owner?.kind === 'customer';
		return {
			ok: true,
			body: {
				owner: owner ? { kind: owner.kind } : guest ? { kind: 'guest' } : null,
				guest,
				dropGuest,
				merged,
				lists: owner ? await lists.ofOwner(site, owner) : [],
				settings: {
					maxLists: site.settings.lists.maxLists,
					maxItems: site.settings.lists.maxItems,
					guests: guestsOn,
					storage: site.settings.guests.storage,
					consentCategory: site.settings.guests.consentCategory,
					share: site.settings.enabled('share') && (signedIn || site.settings.share.allowGuests),
					notify: site.settings.enabled('price_drop_hook') && signedIn,
					manageLists: site.settings.widgets.manageLists,
					layout: site.settings.widgets.layout,
					announce: site.settings.widgets.announce,
				},
			},
		};
	};

	return {
		app,
		product,
		deps,
		lists,
		shares,
		signals,
		siteOf,
		siteFor,
		state,
		guestToken,
		failure,
	};
};

/** @typedef {ReturnType<typeof createWishlist>} Wishlist */
