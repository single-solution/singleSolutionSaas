/**
 * The product's part of a website's Setup sheet (`ss.blueprint/1`, `@ss/contracts` `validateProductBlueprint`):
 * `GET /v1/blueprint?websiteId=`, a call signed by the Portal (`auth: 'portal'`), answered from what the kit already
 * keeps; nothing is stored for it.
 *
 * - **Features** from the manifest with on/off and the business profile answers they suit (`recommendFor`, for the
 *   Portal's advisor); while a feature is on, its settings with their values (`default: true` while the website has
 *   not saved its own) and its lists summarized (entries counted; the product's `blueprint` hook may word a summary).
 *   Shared settings are listed while one of their features is on.
 * - **Connections**: state only (`set`, `state`, when last tested), never a value, its last characters or a test
 *   message.
 * - **Widgets** with readiness (on, served for the website and the merchant database connected), the widget script
 *   address and whether a visitor widget was seen on the website in the last 7 days.
 * - **Staff permissions** (for roles in Accounts and tickets), **events** (`<product>.settings.changed` when the product
 *   publishes events, plus the types its hook names), **docs** (the guide, and `/openapi.json` when the product gives
 *   its OpenAPI document), the product's copy of **business.json**, the Overview **checklist**, the hook's
 *   **summaries** and **build**: what the website builds for each feature that is on (the product's `build` texts,
 *   its guide's "What your website builds"), linked to the feature's section of the guide.
 * - **Switch on** (`POST /v1/blueprint/features?websiteId=`, also a Portal call): the Setup sheet's advisor switches
 *   features on for an Owner or Support admin the Portal names, with the features they need, through the same feature
 *   report as the dashboard's Features page (the Portal checks the admin again when it accepts the report).
 *
 * No secret can leave: besides never reading connection values into the answer, a setting whose value holds a value
 * saved in the website's Connections (8 characters or more, anywhere in it) shows `set: true` instead of its value,
 * and every other string the merchant or the hook wrote (list summaries, the hook's summaries and events, the business
 * name) that holds one is replaced by `[hidden]` (an event is left out), so even a setting or a hook text that repeats
 * a key shows nothing of it. The names and addresses the product itself gives
 * (keys, ids, links) are left as they are, so a connection part that is no secret, such as a bucket named like the
 * product, cannot break the answer.
 * @module
 */
import { isObject } from '@ss/contracts/util';
import { WIDGET_SEEN_MS } from './dashboard.js';
import { defineRoute } from './http/routes.js';
import { problem } from './http/results.js';
import { effectiveStatus } from './status.js';

/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('@ss/contracts').ProductBlueprint} ProductBlueprint */
/**
 * What a product adds to its part of the Setup sheet (its `blueprint` hook): event types it publishes
 * (`<product>.<event>`), list summaries in its own words by list name, and short summaries (each a title and plain
 * text). Never secrets. Anything that does not fit is left out (and logged).
 * @typedef {{ events?: string[], lists?: Record<string, string>, summaries?: Array<{ title: string, text: string }> }} BlueprintAdditions
 */

/** Strings of a website's Connections shorter than this are not treated as secrets (field names, regions …). */
export const SECRET_MIN_LENGTH = 8;
/** What a string holding a secret becomes. */
export const HIDDEN = '[hidden]';
const EVENT = /^[a-z][a-z0-9-]{1,30}(?:\.[a-z][a-z0-9_]{0,30}){1,4}$/;
const MAX_SUMMARIES = 20;
/** Longest list summary (the contract's limit). */
const SUMMARY_MAX = 300;
const SERVING = Object.freeze(['active', 'grace']);

/**
 * Every string of a value with a secret in it replaced by {@link HIDDEN}.
 * @param {unknown} value
 * @param {ReadonlyArray<string>} secrets
 * @returns {unknown}
 */
export const hideSecrets = (value, secrets) => {
	if (secrets.length === 0) return value;
	if (typeof value === 'string') return secrets.some((secret) => value.includes(secret)) ? HIDDEN : value;
	if (Array.isArray(value)) return value.map((item) => hideSecrets(item, secrets));
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideSecrets(item, secrets)]));
	return value;
};

/**
 * Whether any string of a value holds one of the secrets.
 * @param {unknown} value
 * @param {ReadonlyArray<string>} secrets
 * @returns {boolean}
 */
const holdsSecret = (value, secrets) => {
	if (typeof value === 'string') return secrets.some((secret) => value.includes(secret));
	if (Array.isArray(value)) return value.some((item) => holdsSecret(item, secrets));
	if (isObject(value)) return Object.values(value).some((item) => holdsSecret(item, secrets));
	return false;
};

/**
 * The strings a connection value holds that count as secrets.
 * @param {import('./connections.js').ConnectionValue | null} value
 * @returns {string[]}
 */
const secretsIn = (value) =>
	(value === null ? [] : typeof value === 'string' ? [value] : Object.values(value)).filter(
		/** @returns {item is string} */ (item) => typeof item === 'string' && item.length >= SECRET_MIN_LENGTH,
	);

/**
 * A list's summary from its value: an array is counted; an object names the size of each of its lists.
 * @param {unknown} value
 * @returns {{ summary: string, count: number | null }}
 */
export const summarizeList = (value) => {
	if (Array.isArray(value))
		return { summary: `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`, count: value.length };
	const parts = isObject(value)
		? Object.entries(value)
				.filter(([, member]) => Array.isArray(member))
				.map(([key, member]) => `${key}: ${/** @type {unknown[]} */ (member).length}`)
		: [];
	return { summary: parts.length > 0 ? parts.join(', ').slice(0, SUMMARY_MAX) : 'Set', count: null };
};

/** @param {unknown} value @param {number} max */
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * The parts of a hook's answer that fit; the rest is named in `dropped`.
 * @param {unknown} answer
 * @param {string} productId
 * @returns {{ events: string[], lists: Record<string, string>, summaries: Array<{ title: string, text: string }>, dropped: string[] }}
 */
export const checkAdditions = (answer, productId) => {
	/** @type {string[]} */
	const dropped = [];
	const given = isObject(answer) ? answer : {};
	if (!isObject(answer) && answer !== undefined) dropped.push('answer');
	const events = Array.isArray(given.events) ? given.events : [];
	const lists = isObject(given.lists) ? given.lists : {};
	const summaries = Array.isArray(given.summaries) ? given.summaries : [];
	const keptEvents = events.filter((type) => typeof type === 'string' && EVENT.test(type) && type.startsWith(`${productId}.`));
	if (keptEvents.length !== events.length || (given.events !== undefined && !Array.isArray(given.events)))
		dropped.push('events');
	const keptLists = Object.fromEntries(Object.entries(lists).filter(([, text]) => isText(text, SUMMARY_MAX)));
	if (Object.keys(keptLists).length !== Object.keys(lists).length || (given.lists !== undefined && !isObject(given.lists)))
		dropped.push('lists');
	const keptSummaries = summaries
		.filter((item) => isObject(item) && isText(item.title, 120) && isText(item.text, 2000))
		.slice(0, MAX_SUMMARIES)
		.map((item) => ({ title: String(item.title), text: String(item.text) }));
	if (keptSummaries.length !== summaries.length || (given.summaries !== undefined && !Array.isArray(given.summaries)))
		dropped.push('summaries');
	return {
		events: /** @type {string[]} */ (keptEvents),
		lists: /** @type {Record<string, string>} */ (keptLists),
		summaries: keptSummaries,
		dropped,
	};
};

/** Admin roles that may switch features on (the dashboard's Features page has the same). */
const SWITCHING_ROLES = Object.freeze(['owner', 'support']);
const ADMIN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * The features a request switches on, with every feature they need (in manifest order), or why it cannot.
 * @param {import('@ss/contracts').Manifest} manifest
 * @param {unknown} asked
 * @returns {{ ok: true, keys: string[] } | { ok: false, message: string }}
 */
export const withDependencies = (manifest, asked) => {
	const known = new Map(manifest.features.map((feature) => [feature.key, feature]));
	if (!Array.isArray(asked) || asked.length === 0 || asked.some((key) => typeof key !== 'string' || !known.has(key)))
		return { ok: false, message: '`features` must list features of this product.' };
	/** @type {Set<string>} */
	const wanted = new Set();
	/** @param {string} key */
	const add = (key) => {
		if (wanted.has(key)) return;
		wanted.add(key);
		for (const dependency of known.get(key)?.dependsOn ?? []) add(dependency);
	};
	for (const key of asked) add(key);
	return { ok: true, keys: manifest.features.map((feature) => feature.key).filter((key) => wanted.has(key)) };
};

/**
 * The admin a Portal call names: `{ id, name, role }` of an Owner or Support admin.
 * @param {unknown} value
 * @returns {import('./recent.js').Who | null}
 */
const adminOf = (value) => {
	if (!isObject(value)) return null;
	const { id, name, role } = value;
	if (typeof id !== 'string' || !ADMIN_ID.test(id)) return null;
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) return null;
	if (typeof role !== 'string' || !SWITCHING_ROLES.includes(role)) return null;
	return { kind: 'admin', id, name: name.trim(), role };
};

/**
 * @param {{ kit: import('./product.js').Kit, lists: Record<string, import('./server-api.js').ListDefinition>,
 *   hooks: import('./kit-routes.js').ProductHooks, events: boolean, openapi: boolean,
 *   build: Readonly<Record<string, string>> }} options `events`: the product publishes events; `openapi`: it serves
 *   its OpenAPI document at `/openapi.json`; `build`: what the website builds for each feature (checked by
 *   `createProduct`)
 */
export const createBlueprint = ({ kit, lists, hooks, events, openapi, build: buildTexts }) => {
	const { manifest, store, now, logger } = kit;

	/** An address of the manifest made absolute against the product's own address. @param {string} value */
	const absolute = (value) => new URL(value, `${kit.connection.active().baseUrl.replace(/\/+$/, '')}/`).toString();

	/**
	 * Settings of a section with their values; a value holding a secret is never shown (`set: true` instead).
	 * @param {import('@ss/contracts').ManifestFeature['settings']} schema
	 * @param {Record<string, { value: unknown, source: string }>} values
	 * @param {ReadonlyArray<string>} secrets
	 * @returns {import('@ss/contracts').BlueprintSetting[]}
	 */
	const settingsOf = (schema, values, secrets) =>
		Object.entries(schema.properties).map(([key, node]) => {
			const value = values[key]?.value;
			const isDefault = values[key]?.source !== 'website';
			return holdsSecret(value, secrets)
				? { key, title: node.title, set: true, default: isDefault }
				: { key, title: node.title, value, default: isDefault };
		});

	/**
	 * The product's part of the website's Setup sheet.
	 * @param {RequestContext} ctx
	 * @param {import('@ss/contracts').StatusResponse} status
	 * @returns {Promise<ProductBlueprint>}
	 */
	const build = async (ctx, status) => {
		const websiteId = status.websiteId;
		const [{ on }, values, connections, seen, business, saved] = await Promise.all([
			kit.reports.switches(websiteId),
			kit.settings.settingsOfFeatures(
				websiteId,
				kit.settings.sections.map((section) => section.key),
			),
			kit.connections.list(websiteId),
			store.get('widget', websiteId),
			kit.business.get(websiteId, status.domain),
			Promise.all(Object.keys(kit.connections.definitions).map((name) => kit.connections.value(websiteId, name))),
		]);
		const secrets = saved.flatMap(secretsIn);
		/** @template T @param {T} value @returns {T} */
		const hide = (value) => /** @type {T} */ (hideSecrets(value, secrets));
		if (business.stale) ctx.after(() => kit.business.refresh(websiteId, status.domain));
		/** @type {unknown} */
		let answer;
		try {
			answer = hooks.blueprint ? await hooks.blueprint({ websiteId, merchantId: status.merchantId, on }) : undefined;
		} catch (error) {
			logger.warn('the blueprint hook failed', { websiteId, error });
		}
		const additions = checkAdditions(answer, manifest.id);
		if (additions.dropped.length > 0) logger.warn('blueprint additions left out', { websiteId, parts: additions.dropped });
		const listsOn = Object.entries(lists).filter(([, list]) => [list.feature].flat().some((key) => on.includes(key)));
		const summaries = new Map(
			await Promise.all(
				listsOn.map(async ([name, list]) => {
					try {
						return /** @type {const} */ ([name, summarizeList(await list.get(websiteId))]);
					} catch (error) {
						logger.warn('a list could not be read for the blueprint', { websiteId, list: name, error });
						return /** @type {const} */ ([name, { summary: 'Not available right now', count: null }]);
					}
				}),
			),
		);
		// a list of several features shows under the first of them that is on
		const listsOfFeature = (/** @type {string} */ feature) =>
			listsOn
				.filter(([, list]) => [list.feature].flat().find((key) => on.includes(key)) === feature)
				.map(([name, list]) => {
					const counted = /** @type {{ summary: string, count: number | null }} */ (summaries.get(name));
					return { name, title: list.title, summary: hide(additions.lists[name] ?? counted.summary), count: counted.count };
				});
		const effective = effectiveStatus(status, now());
		const database = connections.find((c) => c.name === 'database');
		const databaseSet = database !== undefined && database.status !== 'not_connected';
		const visitorOn = manifest.widgets.some((w) => w.kind === 'visitor' && [w.feature].flat().some((key) => on.includes(key)));
		const installed = visitorOn ? seen !== null && now() - seen.lastSeenAt < WIDGET_SEEN_MS : null;
		const neededConnections = connections.filter((c) => c.neededBy.some((key) => on.includes(key)));
		const businessUrl = `https://${status.domain}/.well-known/business.json`;
		const sharedOn = kit.settings.sections.filter(
			(section) => !manifest.features.some((f) => f.key === section.key) && kit.settings.sectionOn(section.key, on),
		);
		/** @type {ProductBlueprint} */
		const blueprint = {
			productId: manifest.id,
			name: manifest.name,
			version: manifest.version,
			status: effective,
			docs: { guide: absolute(manifest.docsUrl), openapi: openapi ? absolute('/openapi.json') : null },
			business: {
				found: business.found,
				fetchedAt: business.fetchedAt,
				name: business.found ? hide(business.business.name) : null,
				country: business.found ? business.business.country : null,
				timeZone: business.found ? business.business.timeZone : null,
			},
			install: {
				scriptUrl: manifest.widgetScriptUrl === null ? null : absolute(manifest.widgetScriptUrl),
				installed,
				lastSeenAt: seen ? new Date(seen.lastSeenAt).toISOString() : null,
			},
			features: manifest.features.map((feature) => {
				const isOn = on.includes(feature.key);
				return {
					key: feature.key,
					title: feature.name,
					description: feature.description,
					on: isOn,
					dependsOn: [...feature.dependsOn],
					recommendFor: [...(feature.recommendFor ?? [])],
					settings: isOn ? settingsOf(feature.settings, values[feature.key] ?? {}, secrets) : [],
					lists: isOn ? listsOfFeature(feature.key) : [],
				};
			}),
			shared: sharedOn.map((section) => ({
				key: section.key,
				title: section.name,
				features: [...section.features],
				settings: settingsOf(section.settings, values[section.key] ?? {}, secrets),
			})),
			connections: connections.map((c) => ({
				key: c.name,
				title: c.label,
				kind: c.kind,
				neededBy: [...c.neededBy],
				needed: c.neededBy.some((key) => on.includes(key)),
				set: c.status !== 'not_connected',
				state: c.status,
				testedAt: c.testedAt,
			})),
			widgets: manifest.widgets.map((widget) => {
				const features = [widget.feature].flat();
				const widgetOn = features.some((key) => on.includes(key));
				return {
					key: widget.key,
					kind: widget.kind,
					features,
					on: widgetOn,
					ready: widgetOn && SERVING.includes(effective) && databaseSet,
				};
			}),
			staffPermissions: manifest.permissions.map((p) => ({
				key: p.key,
				name: p.name,
				feature: p.feature,
				on: on.includes(p.feature),
			})),
			events: [
				...new Set([
					...(events ? [`${manifest.id}.settings.changed`] : []),
					...additions.events.filter((type) => hide(type) === type),
				]),
			],
			checklist: [
				{ key: 'features', done: on.length > 0, text: `Switch on the ${manifest.name} features this website uses.` },
				...neededConnections.map((c) => ({
					key: `connection.${c.name}`,
					done: c.status === 'connected',
					text: `Connect ${c.label} in the ${manifest.name} dashboard (Connections).`,
				})),
				...(visitorOn
					? [
							{
								key: 'widget',
								done: installed === true,
								text: `Add the ${manifest.name} widget script to every page of your website (Install and tokens in the Portal).`,
							},
						]
					: []),
				{ key: 'business', done: business.found, text: `Publish your business basics at ${businessUrl}.` },
			],
			summaries: hide(additions.summaries),
			build: manifest.features
				.filter((feature) => on.includes(feature.key) && buildTexts[feature.key] !== undefined)
				.map((feature) => ({
					feature: feature.key,
					what: /** @type {string} */ (buildTexts[feature.key]),
					docs: `${absolute(manifest.docsUrl)}#feature-${feature.key}`,
				})),
		};
		return blueprint;
	};

	/**
	 * The status of the website a Portal call names, or the problem to answer.
	 * @param {RequestContext} ctx
	 * @returns {Promise<{ ok: true, status: import('@ss/contracts').StatusResponse } | { ok: false, problem: ReturnType<typeof problem> }>}
	 */
	const websiteOf = async (ctx) => {
		if (ctx.websiteId === null)
			return { ok: false, problem: problem('validation_failed', 'Name the website: ?websiteId=<id>.') };
		const found = await kit.status.lookup(ctx.websiteId, { wait: true, after: ctx.after });
		if (!found.ok)
			return {
				ok: false,
				problem:
					found.code === 'portal_unreachable'
						? problem('portal_unreachable')
						: problem('website_not_found', 'This product does not know the website.'),
			};
		if (found.status.status === 'removed')
			return { ok: false, problem: problem('website_not_found', 'This website does not have this product.') };
		return { ok: true, status: found.status };
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/blueprint',
			auth: 'portal',
			rateLimit: { limit: 60, windowSeconds: 60, per: 'website' },
			handler: async (ctx) => {
				const found = await websiteOf(ctx);
				return found.ok ? build(ctx, found.status) : found.problem;
			},
		}),
		// the advisor's Switch on: `{ features, admin: { id, name, role } }` → `{ version, on, added }`
		defineRoute({
			method: 'POST',
			path: '/v1/blueprint/features',
			auth: 'portal',
			maxBodyBytes: 8 * 1024,
			rateLimit: { limit: 30, windowSeconds: 60, per: 'website' },
			handler: async (ctx) => {
				const body = isObject(ctx.body) ? ctx.body : {};
				const admin = adminOf(body.admin);
				if (admin === null)
					return problem('validation_failed', 'Name the Owner or Support admin: admin { id, name, role }.', {
						errors: [{ path: '/admin', message: 'must be an Owner or Support admin { id, name, role }' }],
					});
				const asked = withDependencies(manifest, body.features);
				if (!asked.ok)
					return problem('validation_failed', asked.message, { errors: [{ path: '/features', message: asked.message }] });
				const found = await websiteOf(ctx);
				if (!found.ok) return found.problem;
				const websiteId = found.status.websiteId;
				const { on, featuresVersion } = await kit.reports.switches(websiteId);
				const added = asked.keys.filter((key) => !on.includes(key));
				if (added.length === 0) return { version: featuresVersion, on, added };
				const result = await kit.reports.reportFeatures({ websiteId, on: [...on, ...added], actor: admin });
				return result.ok ? { version: result.version, on: result.on, added } : result.problem;
			},
		}),
	];

	return Object.freeze({ routes, build });
};
