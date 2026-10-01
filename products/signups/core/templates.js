/**
 * Message templates (pure). Every message the product sends — codes, magic links, new-device notices — is rendered
 * from the merchant's templates (`otp.templates`, `magic_link.templates`, `risk.templates`: per channel and language)
 * or, when none matches, from the string catalog (`message.<purpose>.<channel>[.subject|.body]`). Language fallback:
 * exact tag → base language (`pt-BR` → `pt`) → the website's default language → `en`. Placeholders are `{name}`.
 * @module
 */

/** Message purposes. */
export const PURPOSES = Object.freeze(/** @type {const} */ (['otp', 'magic_link', 'new_device']));

/**
 * @typedef {{ channel: string, lang: string, purpose?: string, subject?: string, body: string }} Template
 * @typedef {Record<string, Record<string, string>>} Catalogs strings by language
 */

/**
 * Fill `{placeholders}` (unknown placeholders stay visible).
 * @param {string} template
 * @param {Record<string, string | number>} params
 */
export const fill = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));

/**
 * Language candidates, most specific first.
 * @param {string | null | undefined} lang
 * @param {string} fallback website default language
 */
export const languageChain = (lang, fallback) => {
	/** @type {string[]} */
	const chain = [];
	for (const candidate of [lang, lang?.split('-')[0], fallback, fallback.split('-')[0], 'en'])
		if (typeof candidate === 'string' && candidate && !chain.includes(candidate)) chain.push(candidate);
	return chain;
};

/**
 * Render a message.
 * @param {{ purpose: typeof PURPOSES[number], channel: string, lang?: string | null, defaultLanguage: string,
 *   templates: readonly Template[], catalogs: Catalogs, params: Record<string, string | number> }} input
 * @returns {{ lang: string, subject?: string, text: string }}
 */
export const renderMessage = ({ purpose, channel, lang, defaultLanguage, templates, catalogs, params }) => {
	const chain = languageChain(lang, defaultLanguage);
	for (const candidate of chain) {
		const custom = templates.find(
			(t) => t.channel === channel && t.lang === candidate && (t.purpose === undefined || t.purpose === purpose),
		);
		if (custom && custom.body)
			return {
				lang: candidate,
				...(channel === 'email' ? { subject: fill(custom.subject || purpose, params) } : {}),
				text: fill(custom.body, params),
			};
	}
	for (const candidate of chain) {
		const catalog = catalogs[candidate];
		if (!catalog) continue;
		const base = `message.${purpose}.${channel}`;
		const body = channel === 'email' ? catalog[`${base}.body`] : catalog[base];
		if (!body) continue;
		const subject = catalog[`${base}.subject`];
		return {
			lang: candidate,
			...(channel === 'email' ? { subject: fill(subject ?? purpose, params) } : {}),
			text: fill(body, params),
		};
	}
	return {
		lang: 'en',
		...(channel === 'email' ? { subject: purpose } : {}),
		text: fill(String(params.code ?? params.link ?? ''), {}),
	};
};
