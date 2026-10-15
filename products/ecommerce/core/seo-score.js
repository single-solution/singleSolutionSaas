/**
 * SEO score per record (PLAN 0.8.10 E42; SEO audit §3.2 A, per record): for a product, category, brand or deal, the
 * checks of its own SEO copy — a title search engines show whole, a written meta description in range, a focus keyword
 * found in the title, the description and the first paragraph, enough text of its own, photos with alternative text
 * and, for a product, a category that links to it — and a 0–100 score, the share of checks passed. Worked out on read
 * from the record alone, never stored (staff reads add it while the `seo` feature is on). No I/O.
 * @module
 */

/** Every check, in the order they are answered. */
export const SEO_CHECKS = Object.freeze(
	/** @type {const} */ ([
		'title_length',
		'description',
		'focus_keyword',
		'keyword_in_title',
		'keyword_in_description',
		'keyword_in_text',
		'text_length',
		'image_alt',
		'in_category',
	]),
);

/** @typedef {(typeof SEO_CHECKS)[number]} SeoCheckKey */
/** @typedef {{ score: number, checks: Array<{ key: SeoCheckKey, ok: boolean }> }} SeoScore */

/** A title search engines show whole: about 60 characters (and more than a word). */
const TITLE = Object.freeze({ min: 10, max: 60 });
/** A meta description in range: long enough to say something, short enough not to be cut. */
const DESCRIPTION = Object.freeze({ min: 50, max: 160 });
/** Words of text of its own a page needs (the thin-page rule of categories, SEO audit G7). */
const TEXT_WORDS = 50;

/**
 * What a record's score is worked out from.
 * @typedef {object} ScoreInput
 * @property {string} name the record's name (its title when it has no SEO title of its own)
 * @property {{ title?: string, description?: string, focusKeyword?: string }} seo its own SEO fields (a deal has no
 *   focus keyword: no keyword checks)
 * @property {string} text its own text as plain text (paragraphs split by blank lines)
 * @property {ReadonlyArray<{ alt?: string }> | null} images its photos; [] = none where one is expected (a product);
 *   null = none and none needed (a category, brand or deal without its image)
 * @property {boolean} [inCategory] a product is in a category (listings and breadcrumbs link to it); left out for others
 */

/** @param {unknown} value */
const plain = (value) =>
	String(value ?? '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * Whether a text holds the focus keyword (any letter case, spaces collapsed).
 * @param {string} text @param {string} keyword
 */
const holds = (text, keyword) => keyword !== '' && plain(text).toLowerCase().includes(keyword.toLowerCase());

/**
 * A record's SEO score and its checks.
 * @param {ScoreInput} input
 * @returns {SeoScore}
 */
export const seoScore = ({ name, seo, text, images, inCategory }) => {
	const title = plain(seo.title) || plain(name);
	const description = plain(seo.description);
	const keyword = plain(seo.focusKeyword);
	const body = String(text ?? '').trim();
	const first = body.split(/\n\s*\n/)[0] ?? '';
	const words = plain(body).split(' ').filter(Boolean).length;
	/** @type {Array<{ key: SeoCheckKey, ok: boolean }>} */
	const checks = [
		{ key: 'title_length', ok: title.length >= TITLE.min && title.length <= TITLE.max },
		{ key: 'description', ok: description.length >= DESCRIPTION.min && description.length <= DESCRIPTION.max },
		...(seo.focusKeyword === undefined
			? []
			: /** @type {Array<{ key: SeoCheckKey, ok: boolean }>} */ ([
					{ key: 'focus_keyword', ok: keyword !== '' },
					{ key: 'keyword_in_title', ok: holds(title, keyword) },
					{ key: 'keyword_in_description', ok: holds(description, keyword) },
					{ key: 'keyword_in_text', ok: holds(first, keyword) },
				])),
		{ key: 'text_length', ok: words >= TEXT_WORDS },
		...(images === null
			? []
			: [
					{
						key: /** @type {const} */ ('image_alt'),
						ok: images.length > 0 && images.every((image) => plain(image.alt) !== ''),
					},
				]),
		...(inCategory === undefined ? [] : [{ key: /** @type {const} */ ('in_category'), ok: inCategory }]),
	];
	const passed = checks.filter((check) => check.ok).length;
	return { score: Math.round((100 * passed) / checks.length), checks };
};

/**
 * A product's score: its photos (one at least, each with alternative text), its description and its categories.
 * @param {Pick<import('./model.js').ProductRecord, 'name' | 'seo' | 'description' | 'media' | 'categoryIds'>} product
 */
export const productScore = (product) =>
	seoScore({
		name: product.name,
		seo: product.seo,
		text: product.description,
		images: product.media,
		inCategory: product.categoryIds.length > 0,
	});

/**
 * A category's score: its description and content summary, its image when it has one.
 * @param {Pick<import('./model.js').CategoryRecord, 'name' | 'seo' | 'description' | 'content' | 'image'>} category
 */
export const categoryScore = (category) =>
	seoScore({
		name: category.name,
		seo: category.seo,
		text: [category.description, category.content?.summary ?? ''].filter(Boolean).join('\n\n'),
		images: category.image ? [category.image] : null,
	});

/**
 * A brand's score: its description, its logo when it has one.
 * @param {Pick<import('./model.js').BrandRecord, 'name' | 'seo' | 'description' | 'logo'>} brand
 */
export const brandScore = (brand) =>
	seoScore({
		name: brand.name,
		seo: brand.seo,
		text: brand.description,
		images: brand.logo ? [brand.logo] : null,
	});

/**
 * A deal page's score: its content, its banner when it has one; a deal has no focus keyword.
 * @param {Pick<import('./model.js').DealRecord, 'name' | 'seo' | 'content' | 'banner'>} deal
 */
export const dealScore = (deal) =>
	seoScore({
		name: deal.name,
		seo: { title: deal.seo.title, description: deal.seo.description },
		text: deal.content,
		images: deal.banner ? [deal.banner] : null,
	});
