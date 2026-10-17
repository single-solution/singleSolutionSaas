/**
 * Public service of the `website` module (INTERFACES.md): the website settings of each website — the facts every product
 * of the website shares (`@ss/contracts` `ss.website-settings/1`: business, brand, region, pages, team).
 *
 * - **Who changes them**: only a signed-in merchant (own websites), Owner or Support, through the console routes
 *   (`website_settings.write`); a product can only read them (`forProduct`, a client assertion, only for a website that
 *   has the product). Finance never.
 * - **A save** replaces one section of the document. It must name the version it read (`version`; a stale one is 409),
 *   the section is tidied (`tidyWebsiteSection`) and the whole document is checked (`validateWebsiteSettings`, 422 with
 *   JSON Pointer paths) before anything is written. A save that changes nothing writes nothing. A save raises the version
 *   by one, writes Activity `website.settings_saved` (section, the names of the fields that changed and, for brand,
 *   region and pages, their small before/after values; never business contacts or team members) and tells every product
 *   on the website (`website.settings_changed`, queued and retried by catalog; a product that cannot be reached never
 *   fails the save).
 * - **Products** learn the version in the status answer (`settingsVersion`) and pull the document only when they hold
 *   an older one.
 * @module
 */
import {
	WEBSITE_SETTINGS_SECTIONS,
	emptyWebsiteSettings,
	missingWebsiteSettings,
	tidyWebsiteSection,
	validateWebsiteSettings,
} from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { SETTINGS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {import('@ss/contracts').WebsiteSection} WebsiteSection */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

/** Sections whose before/after values go into Activity (the others hold contacts and people: only field names). */
const VALUES_RECORDED = new Set(['brand', 'region', 'pages']);
/** A value longer than this is not copied into Activity. */
const VALUE_MAX_CHARS = 500;
/** Entries a Recent changes list shows. */
const CHANGES_SHOWN = 50;

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {ModuleContext} ctx
 */
export const createWebsiteService = (ctx) => {
	const settings = /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(SETTINGS));
	/** @param {string} merchantId */
	const ownerOps = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (settings.forMerchant(merchantId));
	const identity = () => ctx.service('identity');
	const commerce = () => ctx.service('commerce');
	const catalog = () => ctx.service('catalog');

	/**
	 * The document a stored record makes.
	 * @param {string} websiteId
	 * @param {Record<string, any> | null} record
	 * @returns {WebsiteSettings}
	 */
	const documentOf = (websiteId, record) =>
		record
			? /** @type {WebsiteSettings} */ ({
					...emptyWebsiteSettings(websiteId),
					...record.settings,
					version: Number(record.version),
					updatedAt: new Date(record.updatedAt).toISOString(),
				})
			: emptyWebsiteSettings(websiteId);

	/**
	 * The merchant's active website, else 404.
	 * @param {string} merchantId
	 * @param {string} websiteId
	 */
	const websiteOf = async (merchantId, websiteId) => {
		const website = await identity()
			.getWebsite(websiteId)
			.catch((/** @type {{ code?: string }} */ error) => {
				if (error?.code === 'not_found') return null;
				throw error;
			});
		if (!website || website.merchantId !== merchantId || website.status !== 'active')
			throw problem('not_found', 'No such website.');
		return website;
	};

	/**
	 * What each product on the website asks the settings to say, and what is still empty.
	 * @param {WebsiteSettings} document
	 * @returns {Promise<Array<{ productId: string, name: string, requires: string[], missing: string[] }>>}
	 */
	const readinessOf = async (document) => {
		const onSite = /** @type {Array<{ productId: string }>} */ (await commerce().productsOnWebsite(document.websiteId));
		return Promise.all(
			onSite.map(async ({ productId }) => {
				const product = await catalog().getProduct(productId);
				const requires = /** @type {string[]} */ ([...(product.websiteSettingsRequires ?? [])]);
				return { productId, name: String(product.name), requires, missing: missingWebsiteSettings(document, requires) };
			}),
		);
	};

	/**
	 * Tell every product on the website to fetch the new settings (queued and retried; never fails a save).
	 * @param {string} websiteId
	 */
	const tellProducts = async (websiteId) => {
		const onSite = /** @type {Array<{ productId: string }>} */ (await commerce().productsOnWebsite(websiteId));
		for (const { productId } of onSite) {
			try {
				await catalog().notify(productId, { type: 'website.settings_changed', websiteId, what: 'settings' });
			} catch (error) {
				ctx.logger.warn('website.settings_changed not queued', { productId, websiteId, error });
			}
		}
	};

	/**
	 * The fields of a section that differ, with their small before/after values where Activity may keep them.
	 * @param {WebsiteSection} section
	 * @param {Record<string, any>} before
	 * @param {Record<string, any>} after
	 */
	const differences = (section, before, after) => {
		const changed = Object.keys(after).filter((field) => !same(before[field], after[field]));
		/** @type {Record<string, { from?: unknown, to?: unknown, changed?: true }>} */
		const values = {};
		if (VALUES_RECORDED.has(section))
			for (const field of changed) {
				const from = before[field] ?? null;
				const to = after[field] ?? null;
				const small = JSON.stringify(from).length <= VALUE_MAX_CHARS && JSON.stringify(to).length <= VALUE_MAX_CHARS;
				values[field] = small ? { from, to } : { changed: true };
			}
		return { changed, values };
	};

	return Object.freeze({
		/**
		 * A website's settings and what its products need from them (version 0 and an empty document until the first save).
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		get: async ({ merchantId, websiteId }) => {
			await websiteOf(merchantId, websiteId);
			const document = documentOf(websiteId, await ownerOps(merchantId).findOne({ merchantId, _id: websiteId }));
			return { settings: document, readiness: await readinessOf(document) };
		},

		/**
		 * Save one section (see the module notes). A save that changes nothing answers the current document.
		 * @param {{ merchantId: string, websiteId: string, section: string, version: unknown, value: unknown } & Audited} input
		 */
		save: async ({ merchantId, websiteId, section, version, value, actor, requestId = null, ip = null }) => {
			await websiteOf(merchantId, websiteId);
			if (!(/** @type {readonly string[]} */ (WEBSITE_SETTINGS_SECTIONS).includes(section)))
				throw problem('not_found', 'No such section of the website settings.');
			const name = /** @type {WebsiteSection} */ (section);
			const ops = ownerOps(merchantId);
			const record = await ops.findOne({ merchantId, _id: websiteId });
			const current = documentOf(websiteId, record);
			if (version !== current.version)
				throw problem('conflict', 'These settings were saved by someone else meanwhile. Reload them, then save again.');
			const next = { ...current, [name]: tidyWebsiteSection(name, value) };
			if (same(current[name], next[name])) return { settings: current, readiness: await readinessOf(current) };
			const { changed, values } = differences(name, current[name], next[name] ?? {});
			const now = new Date(ctx.now());
			const saved = /** @type {WebsiteSettings} */ ({ ...next, version: current.version + 1, updatedAt: now.toISOString() });
			const checked = validateWebsiteSettings(saved);
			if (!checked.ok)
				throw problem('validation_failed', 'The website settings are not valid.', {
					// one message per value (a length and a pattern may both refuse the same one)
					errors: [...new Map(checked.problems.map((p) => [p.path, { path: p.path, message: p.message }])).values()],
				});
			const sections = Object.fromEntries(WEBSITE_SETTINGS_SECTIONS.map((each) => [each, saved[each]]));
			const stored = {
				version: saved.version,
				updatedAt: now,
				updatedBy: { type: actor.type, id: actor.id },
				settings: sections,
			};
			const conflict = () =>
				problem('conflict', 'These settings were saved by someone else meanwhile. Reload them, then save again.');
			if (record) {
				const result = await ops.updateOne({ merchantId, _id: websiteId, version: current.version }, { $set: stored });
				if (result.matchedCount !== 1) throw conflict();
			} else {
				try {
					await ops.insertOne({ _id: websiteId, merchantId, ...stored });
				} catch (error) {
					throw isDuplicateKey(error) ? conflict() : error;
				}
			}
			await ctx.audit.record({
				actor: /** @type {any} */ (actor),
				action: 'website.settings_saved',
				target: { type: 'website', id: websiteId, merchantId, websiteId },
				after: { section: name, version: saved.version, changed, ...(VALUES_RECORDED.has(name) ? { values } : {}) },
				requestId,
				ip,
			});
			await tellProducts(websiteId);
			return { settings: saved, readiness: await readinessOf(saved) };
		},

		/**
		 * Recent changes of a website's settings, newest first: who, when, which section and which fields. Never a value;
		 * an admin is shown to a merchant under the Branding name, as Activity does.
		 * @param {{ merchantId: string, websiteId: string, viewer: 'admin' | 'merchant' }} input
		 */
		changes: async ({ merchantId, websiteId, viewer }) => {
			await websiteOf(merchantId, websiteId);
			const entries = await ctx.audit.list({
				merchantId,
				targetId: websiteId,
				action: 'website.settings_saved',
				limit: CHANGES_SHOWN,
			});
			/** @type {Map<string, { name: string, deleted: boolean }>} */
			const names = await identity().merchantNames([merchantId]);
			const brand = ctx.config.settings.branding.name;
			return {
				items: entries.map((entry) => ({
					at: new Date(entry.at).toISOString(),
					section: String(entry.after?.section ?? ''),
					version: Number(entry.after?.version ?? 0),
					changed: /** @type {string[]} */ (entry.after?.changed ?? []),
					who: {
						type: String(entry.actor?.type ?? 'system'),
						name:
							entry.actor?.type === 'admin'
								? viewer === 'admin'
									? (entry.actor.name ?? null)
									: brand
								: entry.actor?.type === 'merchant'
									? (names.get(String(entry.actor.id))?.name ?? null)
									: null,
					},
				})),
			};
		},

		/**
		 * The save counter of a website's settings (0: none yet), for the status answer.
		 * @param {string} websiteId
		 * @returns {Promise<number>}
		 */
		versionOf: async (websiteId) => {
			const record = await /** @type {import('../../infra/db.js').MutableOps} */ (settings.acrossMerchants()).findOne(
				{ _id: websiteId },
				{ projection: { version: 1 } },
			);
			return Number(record?.version ?? 0);
		},

		/**
		 * What a product gets (`GET /v1/product/websites/:websiteId/settings?since=`): the version and, when the product
		 * holds an older one, the document. Only for a website that is active and has the product (else 404
		 * `website_not_found`, as the status answer).
		 * @param {{ productId: string, websiteId: string, since: number }} input
		 * @returns {Promise<{ version: number, settings: WebsiteSettings | null }>}
		 */
		forProduct: async ({ productId, websiteId, since }) => {
			const [placement, website] = await Promise.all([
				commerce().productOnWebsite(websiteId, productId),
				identity()
					.getWebsite(websiteId)
					.catch((/** @type {{ code?: string }} */ error) => {
						if (error?.code === 'not_found') return null;
						throw error;
					}),
			]);
			if (!placement || placement.status !== 'added' || !website || website.status !== 'active')
				throw problem('website_not_found', 'This website does not have this product.');
			const record = await /** @type {import('../../infra/db.js').MutableOps} */ (settings.acrossMerchants()).findOne({
				_id: websiteId,
			});
			const version = Number(record?.version ?? 0);
			return { version, settings: record && version > since ? documentOf(websiteId, record) : null };
		},
	});
};

/** @typedef {ReturnType<typeof createWebsiteService>} WebsiteService */
