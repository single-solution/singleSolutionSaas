/**
 * The head a page will have, for the SEO editors' search result and share preview (R7 #105): its title from the
 * merchant's title pattern (its own SEO title, as written or in the pattern, else the page's part from its pattern),
 * its description by the same fallbacks as the SEO answers (`server/seo.js`, `server/seo-landings.js`), its canonical
 * address and its share image, worked out from what the editor holds while the merchant types. Facts a pattern takes
 * from the live catalog (prices, stock, grades, field values) are left empty here, as an empty fact is on the site.
 * Pure: no I/O.
 * @module
 */
import { absolute } from './links.js';
import { asWritten, metaDescription, pageName, pageTitle, patternText, writtenSummary } from './seo-text.js';

/**
 * What the admin widgets get for the preview (widget config `settings.seo`): the website's domain, its name in titles
 * (the SEO brand name, else the business name) and the `seo` settings the head takes.
 * @typedef {{ domain: string, siteName: string, titleTemplate: string, productTitle: string, categoryTitle: string,
 *   productDescription: string, categoryDescription: string, defaultDescription: string, defaultImage: string }} PreviewSettings
 */

/**
 * The page as the editor holds it: its name (a landing page: its heading), its brand's and category's names, its
 * summary and text, its SEO fields, its page address and its first photo.
 * @typedef {{ name: string, brand?: string, category?: string, summary?: string, text?: string,
 *   seo: { title?: string, titleMode?: 'template' | 'as_written', description?: string, canonicalUrl?: string,
 *   ogImage?: string }, url?: string, image?: string }} PreviewPage
 */

/** The placeholders of a pattern (`{name}`, a field's `{attr.<slug>}`). */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*(?:\.[a-z0-9-]+)?)\}/g;

/**
 * The values of a pattern: every placeholder it names that `values` lacks is empty (a fact of the live catalog).
 * @template {Record<string, string>} T
 * @param {string} pattern
 * @param {T} values
 * @returns {T & Record<string, string>}
 */
const valuesFor = (pattern, values) => {
	/** @type {Record<string, string>} */
	const all = {};
	for (const match of pattern.matchAll(PLACEHOLDER)) all[String(match[1])] = '';
	return { ...all, ...values };
};

/**
 * An address on the website (a path, or an https address), else ''.
 * @param {unknown} value
 * @param {string} domain
 */
const siteAddressOf = (value, domain) => {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text.startsWith('https://')) return text;
	return text.startsWith('/') && !text.startsWith('//') && domain ? absolute(text, domain) : '';
};

/**
 * The title, description, address, share image and site name a page will have.
 * @param {'product' | 'category' | 'brand' | 'landing'} kind
 * @param {PreviewPage} page
 * @param {PreviewSettings} settings
 */
export const previewHead = (kind, page, settings) => {
	const { seo } = page;
	const siteName = settings.siteName;
	const values = { name: page.name, brand: page.brand ?? '', category: page.category ?? '', storeName: siteName };
	const titlePattern = String(
		(kind === 'product' ? settings.productTitle : kind === 'category' ? settings.categoryTitle : '') ?? '',
	);
	const textPattern = String(
		(kind === 'product' ? settings.productDescription : kind === 'category' ? settings.categoryDescription : '') ?? '',
	);
	const title = pageTitle(String(settings.titleTemplate ?? ''), {
		own: seo.title?.trim() ?? '',
		// a landing page's own title always goes into the title pattern
		mode: kind === 'landing' ? 'template' : (seo.titleMode ?? 'template'),
		name: kind === 'landing' ? page.name : pageName(titlePattern, valuesFor(titlePattern, values)),
		business: siteName,
	});
	const description = metaDescription(
		asWritten(seo.description),
		kind === 'product' ? writtenSummary(page.summary ?? '') : '',
		patternText(textPattern, valuesFor(textPattern, values)),
		kind === 'category' ? page.summary : '',
		page.text,
		asWritten(settings.defaultDescription),
		kind === 'category' ? page.name : '',
	);
	const domain = settings.domain;
	return {
		title,
		description,
		url: siteAddressOf(seo.canonicalUrl, domain) || page.url || (domain ? `https://${domain}/` : ''),
		image: siteAddressOf(seo.ogImage, domain) || page.image || siteAddressOf(settings.defaultImage, domain),
		siteName,
	};
};
