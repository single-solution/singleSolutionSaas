/**
 * The server HTML core of a product page and of a listing's grid (SEO audit G3), for merchants who show them with the
 * widgets: plain, semantic HTML the website prints into the widget's place, so search engines and shoppers read the
 * content before any script runs (the widget then takes the place over). Built only from escaped text, https links and
 * image sizes Ecommerce writes, and description HTML cleaned again: no script, no style, no event attribute. No I/O.
 * @module
 */
import { escapeHtml } from '@ss/contracts/text';
import { cleanHtml } from './catalog-content.js';

/**
 * An https address for an attribute, or '' (links and images take nothing else).
 * @param {unknown} value
 */
const linkOf = (value) => (/^https:\/\/[^\s"<>]+$/.test(String(value ?? '')) ? escapeHtml(value) : '');

/**
 * A widget text with its `{placeholders}` filled (the website's own words, else the defaults).
 * @param {string} template
 * @param {Record<string, string | number>} [values]
 */
export const say = (template, values = {}) =>
	template.replace(/\{([A-Za-z]+)\}/g, (all, /** @type {string} */ key) =>
		Object.hasOwn(values, key) ? String(values[key]) : all,
	);

/** @typedef {{ url: string, alt: string, width?: number, height?: number }} HtmlImage */

/**
 * An image with its size (so the page does not move while it loads, G14) and its text.
 * @param {HtmlImage | null} image
 * @param {boolean} lazy below the fold
 */
const imageHtml = (image, lazy) => {
	const src = linkOf(image?.url);
	if (!image || !src) return '';
	const size = Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height);
	return `<img src="${src}" alt="${escapeHtml(image.alt)}"${size ? ` width="${image.width}" height="${image.height}"` : ''}${lazy ? ' loading="lazy"' : ''}>`;
};

/**
 * A price as shown, with the struck-through price beside it.
 * @param {string} price @param {string} was '' = none
 */
const priceHtml = (price, was) => `${escapeHtml(price)}${was ? ` <s>${escapeHtml(was)}</s>` : ''}`;

/**
 * Questions as a description list.
 * @param {Array<{ term: string, detail: string }>} entries
 */
const listHtml = (entries) =>
	`<dl>${entries.map((entry) => `<dt>${escapeHtml(entry.term)}</dt><dd>${escapeHtml(entry.detail)}</dd>`).join('')}</dl>`;

/**
 * What a product page shows, written.
 * @typedef {object} ProductHtml
 * @property {string} name
 * @property {Array<{ name: string, url: string }>} trail the home page and its categories
 * @property {string} price the price shown (or the range), written in the website's format
 * @property {string} was the struck-through price, written ('' = none)
 * @property {string} availability
 * @property {string} rating ('' = none)
 * @property {HtmlImage | null} image its first photo
 * @property {string} descriptionHtml the merchant's description HTML ('' = none)
 * @property {string} description its plain text (used without HTML)
 * @property {Array<{ name: string, value: string }>} specs
 * @property {Array<{ question: string, answer: string }>} faqs
 * @property {{ description: string, specs: string, faqs: string }} headings
 */

/**
 * The product page's core (G3): its breadcrumb links, the name as the page's h1, its photo, the price shown with the
 * struck-through one, availability, rating, description, specs and questions.
 * @param {ProductHtml} page
 */
export const productHtml = (page) => {
	const description =
		cleanHtml(page.descriptionHtml) ||
		page.description
			.split(/\n\s*\n/)
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => `<p>${escapeHtml(part)}</p>`)
			.join('');
	return [
		page.trail.length > 0
			? `<nav><ol>${page.trail.map((step) => `<li><a href="${linkOf(step.url)}">${escapeHtml(step.name)}</a></li>`).join('')}</ol></nav>`
			: '',
		`<h1>${escapeHtml(page.name)}</h1>`,
		imageHtml(page.image, false),
		`<p>${priceHtml(page.price, page.was)}</p>`,
		`<p>${escapeHtml(page.availability)}</p>`,
		page.rating ? `<p>${escapeHtml(page.rating)}</p>` : '',
		description ? `<section><h2>${escapeHtml(page.headings.description)}</h2>${description}</section>` : '',
		page.specs.length > 0
			? `<section><h2>${escapeHtml(page.headings.specs)}</h2>${listHtml(page.specs.map((spec) => ({ term: spec.name, detail: spec.value })))}</section>`
			: '',
		page.faqs.length > 0
			? `<section><h2>${escapeHtml(page.headings.faqs)}</h2>${listHtml(page.faqs.map((faq) => ({ term: faq.question, detail: faq.answer })))}</section>`
			: '',
	].join('');
};

/**
 * The listing grid's core (G3): the page's products as links with their photos and prices shown, and the links to the
 * previous and next pages.
 * @param {{ items: Array<{ name: string, url: string, price: string, was: string, image: HtmlImage | null }>,
 *   prev: string | null, next: string | null, words: { pages: string, prev: string, next: string } }} list
 */
export const listingHtml = ({ items, prev, next, words }) =>
	[
		items.length > 0
			? `<ul>${items
					.map(
						(item) =>
							`<li><a href="${linkOf(item.url)}">${imageHtml(item.image, true)}${escapeHtml(item.name)}</a> <span>${priceHtml(item.price, item.was)}</span></li>`,
					)
					.join('')}</ul>`
			: '',
		prev || next
			? `<nav aria-label="${escapeHtml(words.pages)}">${[
					prev ? `<a rel="prev" href="${linkOf(prev)}">${escapeHtml(words.prev)}</a>` : '',
					next ? `<a rel="next" href="${linkOf(next)}">${escapeHtml(words.next)}</a>` : '',
				]
					.filter(Boolean)
					.join(' ')}</nav>`
			: '',
	].join('');
