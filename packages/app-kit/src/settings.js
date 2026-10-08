/**
 * The settings store (PLAN 0.4.2, 0.4.8, 0.4.10): one value per website × setting in the product database, validated
 * against the feature's settings schema. Reading returns the website's saved value, else the global default (the same
 * store with `websiteId: null`, Owner only), else the schema default. Reset deletes the saved value. Widget texts
 * (English defaults from `strings/en.json`; a text is saved only with the same `{placeholders}`) and the theme
 * (colours, font family, radius, mode, custom CSS) are stored the same way, one value per field. Every change writes
 * Recent changes.
 * @module
 */
import { validateSettingValue } from '@ss/contracts';
import { problem } from './http/results.js';
import { samePlaceholders } from './text.js';
import { isObject } from './util.js';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').ManifestFeature} ManifestFeature */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./recent.js').Who} Who */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** @typedef {'website' | 'default' | 'built-in'} Source where a value comes from */
/** @typedef {{ colors: Record<string, string>, fontFamily: string, radius: number, mode: 'light' | 'dark' | 'auto', customCss: string }} Theme */
/** @typedef {{ ok: true } | { ok: false, problem: ProblemResult }} Change */

/** The theme before anyone changes it: product CSS supplies the colours. */
const DEFAULT_THEME = Object.freeze({
	colors: Object.freeze({}),
	fontFamily: 'inherit',
	radius: 8,
	mode: 'auto',
	customCss: '',
});
/** Longest custom CSS, in bytes. */
const MAX_CUSTOM_CSS_BYTES = 20 * 1024;
/** Longest widget text. */
const MAX_TEXT_LENGTH = 2000;
const THEME_FIELDS = /** @type {const} */ (['colors', 'fontFamily', 'radius', 'mode', 'customCss']);
const COLOR_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/**
 * Why a theme field value is invalid, or null.
 * @param {string} field
 * @param {unknown} value
 * @returns {string | null}
 */
const themeViolation = (field, value) => {
	switch (field) {
		case 'colors':
			return isObject(value) &&
				Object.keys(value).length <= 24 &&
				Object.entries(value).every(
					([name, color]) => COLOR_NAME.test(name) && typeof color === 'string' && COLOR.test(color),
				)
				? null
				: 'colors maps up to 24 names to #rrggbb colours';
		case 'fontFamily':
			return value === 'inherit' || (typeof value === 'string' && FONT.test(value))
				? null
				: "fontFamily is 'inherit' or a font name";
		case 'radius':
			return Number.isInteger(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= 24
				? null
				: 'radius is 0–24 px';
		case 'mode':
			return value === 'light' || value === 'dark' || value === 'auto' ? null : 'mode is light, dark or auto';
		case 'customCss':
			return typeof value === 'string' && Buffer.byteLength(value) <= MAX_CUSTOM_CSS_BYTES
				? null
				: 'customCss is at most 20 kB';
		default:
			return `unknown theme field ${field}`;
	}
};

/**
 * @param {{ store: Store, manifest: Manifest, strings: Record<string, string>, recent: import('./recent.js').RecentChanges,
 *   now: () => number }} options
 */
export const createSettings = ({ store, manifest, strings, recent, now }) => {
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
	/** @param {string | null} websiteId @param {Who} who @param {string} what @param {string} detail */
	const log = (websiteId, who, what, detail) =>
		recent.record({ websiteId, who, what: websiteId === null ? 'defaults' : what, detail });

	/** @param {string} key @returns {ManifestFeature | undefined} */
	const featureOf = (key) => manifest.features.find((feature) => feature.key === key);

	/**
	 * Every setting of a feature with its value and source.
	 * @param {string | null} websiteId null = the global defaults
	 * @param {string} featureKey
	 * @returns {Promise<Record<string, { value: any, source: Source }>>}
	 */
	const settingsOf = async (websiteId, featureKey) => {
		const feature = featureOf(featureKey);
		if (!feature) return {};
		const resolve = await snapshot(websiteId);
		return Object.fromEntries(
			Object.entries(feature.settings.properties).map(([key, node]) => [
				key,
				resolve('setting', `${featureKey}.${key}`, node.default),
			]),
		);
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
		await log(
			websiteId,
			who,
			'settings',
			`${feature.name} › ${node.title}: ${value === undefined ? 'reset to default' : 'changed'}`,
		);
		return { ok: true };
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
		await log(websiteId, who, 'texts', `Text ${key}: ${value === undefined ? 'reset to English' : 'changed'}`);
		return { ok: true };
	};

	/**
	 * The theme with the source of each field.
	 * @param {string | null} websiteId
	 * @returns {Promise<{ theme: Theme, sources: Record<keyof Theme, Source> }>}
	 */
	const themeOf = async (websiteId) => {
		const resolve = await snapshot(websiteId);
		const entries = THEME_FIELDS.map((field) => /** @type {const} */ ([field, resolve('theme', field, DEFAULT_THEME[field])]));
		return {
			theme: /** @type {Theme} */ (Object.fromEntries(entries.map(([field, { value }]) => [field, value]))),
			sources: /** @type {Record<keyof Theme, Source>} */ (
				Object.fromEntries(entries.map(([field, { source }]) => [field, source]))
			),
		};
	};

	/**
	 * Save theme fields; a field set to `null` is reset.
	 * @param {{ websiteId: string | null, theme: unknown, who: Who }} input
	 * @returns {Promise<Change>}
	 */
	const setTheme = async ({ websiteId, theme, who }) => {
		if (!isObject(theme) || Object.keys(theme).length === 0)
			return { ok: false, problem: problem('validation_failed', 'Send the theme fields to change.') };
		for (const [field, value] of Object.entries(theme)) {
			const violation =
				value === null && THEME_FIELDS.includes(/** @type {any} */ (field)) ? null : themeViolation(field, value);
			if (violation) return { ok: false, problem: problem('validation_failed', violation) };
		}
		for (const [field, value] of Object.entries(theme))
			await write(websiteId, 'theme', field, value === null ? undefined : value);
		await log(websiteId, who, 'theme', `Theme: ${Object.keys(theme).join(', ')} changed`);
		return { ok: true };
	};

	return Object.freeze({
		featureOf,
		settingsOf,
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
		setTheme,
	});
};

/** @typedef {ReturnType<typeof createSettings>} Settings */
