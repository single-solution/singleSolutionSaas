/**
 * The settings store (PLAN 0.4.2, 0.4.8, 0.4.10): one value per website × setting in the product database, validated
 * against the feature's settings schema. Reading returns the website's saved value, else the global default (the same
 * store with `websiteId: null`, Owner only), else the schema default. Reset deletes the saved value. Widget texts
 * (English defaults from `strings/en.json`; a text is saved only with the same `{placeholders}`) are stored the same
 * way. Every change writes Recent changes.
 *
 * A setting marked `x-ui.defaultFrom` (a value of the website's settings, `region.language`) starts from the Portal:
 * while the website has no saved value of its own (or an empty one) and the Portal holds a value there, the setting
 * takes the Portal's value (source `portal`, `from` names the path); the merchant changes it by saving their own.
 *
 * The theme and the Format of a website are the Portal's alone (`website-settings.js`; Website settings › Brand and look
 * and Region and format): they are read from the Portal's copy (source `portal`; the built-in defaults, source
 * `built-in`, while the Portal holds nothing yet) and a save is refused with 409 `managed_by_portal`.
 *
 * Settings come in sections: each feature's settings, plus the product's shared settings (PLAN 0.8.10 A2, A11): a
 * group of settings several features use, stored once under the group's key (`<group>.<setting>`) and in use, and
 * shown to merchants, while any of its features is on.
 * @module
 */
import { validateSettingValue } from '@ss/contracts';
import { FORMAT_FIELDS } from '@ss/contracts/format';
import { placeholdersOf } from '@ss/contracts/templates';
import {
	formatOf as formatFrom,
	isUnsetWebsiteValue,
	themeOf as themeFrom,
	websiteSettingAt,
} from '@ss/contracts/website-settings';
import { problem } from './http/results.js';

/**
 * True when two texts carry exactly the same placeholders (in any order, each any number of times).
 * @param {string} a
 * @param {string} b
 */
const samePlaceholders = (a, b) => placeholdersOf(a).sort().join('\n') === placeholdersOf(b).sort().join('\n');

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').ManifestFeature} ManifestFeature */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./recent.js').Who} Who */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** @typedef {'website' | 'default' | 'built-in' | 'portal'} Source where a value comes from (`portal`: the website's settings in the Portal) */
/** @typedef {{ colors: Record<string, string>, fontFamily: string, radius: number, mode: 'light' | 'dark' | 'auto', customCss: string }} Theme */
/**
 * A save's outcome: what changed in words (`label`, for example `Notes › Greeting`, and `detail`, for example `changed`),
 * as Recent changes shows it (`<label>: <detail>`) and the activity log keeps it.
 * @typedef {{ ok: true, label: string, detail: string } | { ok: false, problem: ProblemResult }} Change
 */
/** @typedef {{ name: string, features: string[], settings: ManifestFeature['settings'] }} SharedSettings */
/**
 * A settings section: a feature's settings, or shared settings with the features that use them.
 * @typedef {{ key: string, name: string, settings: ManifestFeature['settings'], features: string[] }} Section
 */

/** Longest widget text. */
const MAX_TEXT_LENGTH = 2000;
/** The fields of the theme, in the order the Portal's settings give them. */
const THEME_FIELDS = /** @type {const} */ (['colors', 'fontFamily', 'radius', 'mode', 'customCss']);

/**
 * @param {{ store: Store, manifest: Manifest, strings: Record<string, string>, recent: import('./recent.js').RecentChanges,
 *   now: () => number, shared?: Record<string, SharedSettings>, website: import('./website-settings.js').WebsiteSettingsCache,
 *   portalUrl: () => string | null }} options `website`: the Portal's copy of the website's settings; `portalUrl`: the
 *   pinned Portal address, named in the answer of a refused save
 */
export const createSettings = ({ store, manifest, strings, recent, now, shared = {}, website, portalUrl }) => {
	/** Every settings section: the features', then the shared ones. @type {ReadonlyArray<Section>} */
	const sections = Object.freeze([
		...manifest.features.map((feature) => ({
			key: feature.key,
			name: feature.name,
			settings: feature.settings,
			features: [feature.key],
		})),
		...Object.entries(shared).map(([key, group]) => ({
			key,
			name: group.name,
			settings: group.settings,
			features: [...group.features],
		})),
	]);
	/** @param {string | null} websiteId @param {string} kind @param {string} key */
	const idOf = (websiteId, kind, key) => `${websiteId ?? '*'}|${kind}|${key}`;
	/**
	 * The saved values of a website and the global defaults, read once per call.
	 * @param {string | null} websiteId
	 */
	const snapshot = async (websiteId) => {
		/** @param {import('./stores/types.js').Doc[]} docs */
		const byKey = (docs) => new Map(docs.map((doc) => [`${doc.kind}|${doc.key}`, doc.value]));
		const [own, global] = await Promise.all([
			websiteId === null ? [] : store.list('settings', { websiteId }),
			store.list('settings', { websiteId: null }),
		]);
		const ownValues = byKey(own);
		const globalValues = byKey(global);
		/**
		 * @param {string} kind
		 * @param {string} key
		 * @param {unknown} fallback
		 * @returns {{ value: any, source: Source }}
		 */
		return (kind, key, fallback) => {
			const id = `${kind}|${key}`;
			if (ownValues.has(id)) return { value: ownValues.get(id), source: 'website' };
			if (globalValues.has(id)) return { value: globalValues.get(id), source: 'default' };
			return { value: fallback, source: 'built-in' };
		};
	};
	/**
	 * @param {string | null} websiteId
	 * @param {string} kind
	 * @param {string} key
	 * @param {unknown} value `undefined` deletes the saved value
	 */
	const write = async (websiteId, kind, key, value) => {
		if (value === undefined) await store.delete('settings', idOf(websiteId, kind, key));
		else await store.put('settings', idOf(websiteId, kind, key), { websiteId, kind, key, value, at: now() });
	};
	/**
	 * Record a saved change in Recent changes and answer it.
	 * @param {string | null} websiteId @param {Who} who @param {string} what @param {string} label @param {string} detail
	 * @returns {Promise<Change>}
	 */
	const log = async (websiteId, who, what, label, detail) => {
		await recent.record({ websiteId, who, what: websiteId === null ? 'defaults' : what, detail: `${label}: ${detail}` });
		return { ok: true, label, detail };
	};

	/**
	 * The refusal of a save the Portal owns: 409 `managed_by_portal`, naming the Portal and where to change it.
	 * @param {string} where the section of Website settings
	 * @returns {Change}
	 */
	const managedByPortal = (where) => ({
		ok: false,
		problem: problem('managed_by_portal', `This is set in the Portal: Website settings › ${where}.`, {
			extensions: { portalUrl: portalUrl(), section: where },
		}),
	});

	/** A feature's settings or shared settings, by key. @param {string} key @returns {Section | undefined} */
	const featureOf = (key) => sections.find((section) => section.key === key);

	/**
	 * Whether a section's settings are in use: its feature, or any feature sharing them, is on.
	 * @param {string} key
	 * @param {ReadonlyArray<string>} on the switched-on features
	 */
	const sectionOn = (key, on) => (featureOf(key)?.features ?? []).some((feature) => on.includes(feature));

	/**
	 * The Portal's settings of a website for the settings that start from them, or null (global defaults, or none yet).
	 * @param {string | null} websiteId
	 */
	const portalOf = async (websiteId) => (websiteId === null ? null : website.get(websiteId));

	/**
	 * A setting that starts from the Portal (`x-ui.defaultFrom`) takes the Portal's value until the website saves one of its
	 * own: its saved value wins unless it is empty (left empty means: use the website's). A Portal value that is empty,
	 * or that the setting would not accept (not one of its choices, too long), changes nothing.
	 * @param {ManifestFeature['settings']} schema
	 * @param {string} key
	 * @param {{ value: any, source: Source }} found what the website, the global defaults and the schema say
	 * @param {import('@ss/contracts').WebsiteSettings | null} portal
	 * @returns {{ value: any, source: Source, from?: string }}
	 */
	const startsFromPortal = (schema, key, found, portal) => {
		const from = schema.properties[key]?.['x-ui']?.defaultFrom;
		if (!from || portal === null) return found;
		if (found.source === 'website' && !isUnsetWebsiteValue(found.value)) return found;
		const inherited = websiteSettingAt(portal, from);
		if (isUnsetWebsiteValue(inherited) || !validateSettingValue(schema, key, inherited).ok) return found;
		return { value: structuredClone(inherited), source: 'portal', from };
	};

	/**
	 * The settings of a feature with their values and sources, from a snapshot.
	 * @param {string} featureKey
	 * @param {Awaited<ReturnType<typeof snapshot>>} resolve
	 * @param {import('@ss/contracts').WebsiteSettings | null} portal the website's settings in the Portal (null: none, or the global defaults)
	 * @returns {Record<string, { value: any, source: Source, from?: string }>}
	 */
	const valuesOf = (featureKey, resolve, portal) => {
		const feature = featureOf(featureKey);
		if (!feature) return {};
		return Object.fromEntries(
			Object.entries(feature.settings.properties).map(([key, node]) => [
				key,
				startsFromPortal(feature.settings, key, resolve('setting', `${featureKey}.${key}`, node.default), portal),
			]),
		);
	};

	/**
	 * Every setting of a feature with its value and source.
	 * @param {string | null} websiteId null = the global defaults
	 * @param {string} featureKey
	 * @returns {Promise<Record<string, { value: any, source: Source }>>}
	 */
	const settingsOf = async (websiteId, featureKey) => valuesOf(featureKey, await snapshot(websiteId), await portalOf(websiteId));

	/**
	 * The settings of several features, read once (the dashboard's Settings and Defaults).
	 * @param {string | null} websiteId null = the global defaults
	 * @param {string[]} featureKeys
	 * @returns {Promise<Record<string, Record<string, { value: any, source: Source }>>>}
	 */
	const settingsOfFeatures = async (websiteId, featureKeys) => {
		const [resolve, portal] = await Promise.all([snapshot(websiteId), portalOf(websiteId)]);
		return Object.fromEntries(featureKeys.map((key) => [key, valuesOf(key, resolve, portal)]));
	};

	/**
	 * Save or reset one setting (`value: undefined` resets).
	 * @param {{ websiteId: string | null, feature: string, key: string, value: unknown, who: Who }} input
	 * @returns {Promise<Change>}
	 */
	const setSetting = async ({ websiteId, feature: featureKey, key, value, who }) => {
		const feature = featureOf(featureKey);
		const node = feature?.settings.properties[key];
		if (!feature || !node) return { ok: false, problem: problem('not_found', 'No such setting.') };
		if (value !== undefined) {
			const checked = validateSettingValue(feature.settings, key, value);
			if (!checked.ok)
				return {
					ok: false,
					problem: problem('validation_failed', `${node.title} is not valid.`, { errors: [...checked.problems] }),
				};
		}
		await write(websiteId, 'setting', `${featureKey}.${key}`, value);
		return log(
			websiteId,
			who,
			'settings',
			`${feature.name} › ${node.title}`,
			value === undefined ? 'reset to default' : 'changed',
		);
	};

	/**
	 * Every widget text with its English default, value and source.
	 * @param {string | null} websiteId
	 * @returns {Promise<Array<{ key: string, english: string, value: string, source: Source }>>}
	 */
	const textsOf = async (websiteId) => {
		const resolve = await snapshot(websiteId);
		return Object.entries(strings).map(([key, english]) => ({ key, english, ...resolve('text', key, english) }));
	};

	/**
	 * Save or reset one widget text (`value: undefined` restores English).
	 * @param {{ websiteId: string | null, key: string, value: unknown, who: Who }} input
	 * @returns {Promise<Change>}
	 */
	const setText = async ({ websiteId, key, value, who }) => {
		if (!Object.hasOwn(strings, key)) return { ok: false, problem: problem('not_found', 'No such text.') };
		const english = /** @type {string} */ (strings[key]);
		if (value !== undefined) {
			if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH)
				return { ok: false, problem: problem('validation_failed', `A text is 1–${MAX_TEXT_LENGTH} characters.`) };
			if (!samePlaceholders(value, english))
				return {
					ok: false,
					problem: problem('validation_failed', 'The text must keep the same {placeholders} as the English text.'),
				};
		}
		await write(websiteId, 'text', key, value);
		return log(websiteId, who, 'texts', `Text ${key}`, value === undefined ? 'reset to English' : 'changed');
	};

	/**
	 * The theme with the source of each field: the Portal's Brand and look (`portal`), the built-in look while the Portal
	 * holds nothing for the website yet (`built-in`).
	 * @param {string} websiteId
	 * @returns {Promise<{ theme: Theme, sources: Record<keyof Theme, Source> }>}
	 */
	const themeOf = async (websiteId) => {
		const document = await website.document(websiteId);
		const source = /** @type {Source} */ (document.version > 0 ? 'portal' : 'built-in');
		return {
			theme: themeFrom(document),
			sources: /** @type {Record<keyof Theme, Source>} */ (Object.fromEntries(THEME_FIELDS.map((field) => [field, source]))),
		};
	};

	/**
	 * The Format with the source of each field (K7), as the theme.
	 * @param {string} websiteId
	 * @returns {Promise<{ format: import('@ss/contracts').Format, sources: Record<keyof import('@ss/contracts').Format, Source> }>}
	 */
	const formatOf = async (websiteId) => {
		const document = await website.document(websiteId);
		const source = /** @type {Source} */ (document.version > 0 ? 'portal' : 'built-in');
		return {
			format: formatFrom(document),
			sources: /** @type {Record<keyof import('@ss/contracts').Format, Source>} */ (
				Object.fromEntries(FORMAT_FIELDS.map((field) => [field, source]))
			),
		};
	};

	return Object.freeze({
		sections,
		sectionOn,
		featureOf,
		settingsOf,
		settingsOfFeatures,
		/**
		 * The values of a feature's settings for a website (for product code).
		 * @param {string} websiteId
		 * @param {string} featureKey
		 * @returns {Promise<Record<string, any>>}
		 */
		values: async (websiteId, featureKey) =>
			Object.fromEntries(Object.entries(await settingsOf(websiteId, featureKey)).map(([key, { value }]) => [key, value])),
		setSetting,
		textsOf,
		/**
		 * Every widget text of a website as `{ key: text }` (for widgets).
		 * @param {string} websiteId
		 * @returns {Promise<Record<string, string>>}
		 */
		texts: async (websiteId) => Object.fromEntries((await textsOf(websiteId)).map(({ key, value }) => [key, value])),
		setText,
		themeOf,
		formatOf,
		/**
		 * The refusal of a save of the theme (always: it is the Portal's, Website settings › Brand and look).
		 * @returns {Change}
		 */
		refuseTheme: () => managedByPortal('Brand and look'),
		/**
		 * The refusal of a save of the Format (always: it is the Portal's, Website settings › Region and format).
		 * @returns {Change}
		 */
		refuseFormat: () => managedByPortal('Region and format'),
	});
};

/** @typedef {ReturnType<typeof createSettings>} Settings */
