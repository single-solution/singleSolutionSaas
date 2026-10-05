/**
 * Per-website string overrides of delivered elements (F.18, pure validation). A merchant rewords an element's text
 * for one website and one language (or `*`, every language); the compiler applies the overrides on top of the
 * product's catalogs (`strings/<lang>.json`, sliced per element) when it builds the website bundle.
 * @module
 */
import { isId, isLanguageTag } from '@ss/contracts';

const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const STRING_KEY = /^[A-Za-z][\w.-]*$/;
export const MAX_OVERRIDE_KEYS = 200;
export const MAX_OVERRIDE_TEXT = 2000;
export const MAX_OVERRIDE_BYTES = 32 * 1024;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check a string override request: `body` is `{ strings: { key: text } }` (an empty object removes the override).
 * @param {{ appId: string, element: string, language: string, body: unknown }} input
 * @returns {{ ok: true, strings: Record<string, string> } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkStringOverride = ({ appId, element, language, body }) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	if (!isId(appId, 'app')) errors.push({ path: '/appId', message: 'must be an app id' });
	if (typeof element !== 'string' || element.length > 40 || !ELEMENT_KEY.test(element))
		errors.push({ path: '/element', message: 'must be an element key' });
	if (language !== '*' && !isLanguageTag(language))
		errors.push({ path: '/language', message: 'must be a BCP 47 language tag or *' });
	const strings = isObject(body) ? body.strings : undefined;
	/** @type {Record<string, string>} */
	const out = {};
	if (!isObject(body) || !isObject(strings) || Object.keys(body).some((key) => key !== 'strings'))
		errors.push({ path: '/strings', message: 'the body must be { strings: { key: text } }' });
	else {
		const entries = Object.entries(strings);
		if (entries.length > MAX_OVERRIDE_KEYS) errors.push({ path: '/strings', message: `at most ${MAX_OVERRIDE_KEYS} strings` });
		for (const [key, text] of entries) {
			if (!STRING_KEY.test(key) || key.length > 200) errors.push({ path: `/strings/${key}`, message: 'invalid key' });
			else if (typeof text !== 'string' || text.length > MAX_OVERRIDE_TEXT)
				errors.push({ path: `/strings/${key}`, message: `must be text of at most ${MAX_OVERRIDE_TEXT} characters` });
			else out[key] = text;
		}
		if (JSON.stringify(out).length > MAX_OVERRIDE_BYTES)
			errors.push({ path: '/strings', message: `must be at most ${MAX_OVERRIDE_BYTES} bytes` });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, strings: out };
};
