/**
 * Addresses of the shop's pages on the merchant's website (PLAN 0.8.10 E13): the `catalog` settings `productUrl`
 * (`{slug}`, `{id}`, `{category}` the first category's slug, `{categoryPath}` its slugs from the root, `{brand}`),
 * `categoryUrl` (`{slug}`, `{path}` the slugs from the root) and `variantQuery` (`{grade}` and `{attributes}`, the
 * variant's `slug=value` pairs). Every link the product makes uses them. Slug history: a product's or category's
 * earlier slugs (at most 20) still find it, so the site can send a 308 to the new address. No I/O.
 * @module
 */

/** At most this many earlier slugs are kept. */
export const MAX_PREVIOUS_SLUGS = 20;

/**
 * @typedef {object} LinkContext
 * @property {string} domain the website's domain
 * @property {ReadonlyMap<string, { slug: string, path: string[] }>} categories by id
 * @property {ReadonlyMap<string, { slug: string }>} brands by id
 */

/** @param {string} value */
const part = (value) => encodeURIComponent(value);

/**
 * A path or https address made absolute on the website, with empty path segments removed.
 * @param {string} path
 * @param {string} domain
 */
export const absolute = (path, domain) => {
	if (/^https:\/\//.test(path)) return path;
	const clean = `/${path}`.replace(/\/{2,}/g, '/');
	return `https://${domain}${clean}`;
};

/**
 * The slugs of a category and its ancestors, root first.
 * @param {string} id
 * @param {LinkContext['categories']} categories
 */
export const slugTrail = (id, categories) => {
	const category = categories.get(id);
	if (!category) return [];
	return /** @type {string[]} */ (
		[...category.path.map((ancestor) => categories.get(ancestor)?.slug), category.slug].filter(
			(slug) => typeof slug === 'string' && slug !== '',
		)
	);
};

/**
 * A product's page.
 * @param {string} template the `productUrl` setting
 * @param {{ id: string, slug: string, categoryIds?: string[], brandId?: string | null }} product
 * @param {LinkContext} context
 */
export const productLink = (template, product, { domain, categories, brands }) => {
	const first = product.categoryIds?.[0] ?? '';
	const trail = slugTrail(first, categories);
	const path = String(template || '/products/{slug}')
		.replaceAll('{slug}', part(product.slug))
		.replaceAll('{id}', part(product.id))
		.replaceAll('{categoryPath}', trail.map(part).join('/'))
		.replaceAll('{category}', part(trail.at(-1) ?? ''))
		.replaceAll('{brand}', part(product.brandId ? (brands.get(product.brandId)?.slug ?? '') : ''));
	return absolute(path, domain);
};

/**
 * A category's page.
 * @param {string} template the `categoryUrl` setting
 * @param {{ id?: string, slug: string, path?: string[] }} category
 * @param {LinkContext} context
 */
export const categoryLink = (template, category, { domain, categories }) => {
	const trail = category.id && categories.has(category.id) ? slugTrail(category.id, categories) : [category.slug];
	const path = String(template || '/categories/{slug}')
		.replaceAll('{slug}', part(category.slug))
		.replaceAll('{path}', trail.map(part).join('/'));
	return absolute(path, domain);
};

/**
 * The query that names a variant on its product's page (`variantQuery`): `{grade}` and `{attributes}` (the variant's
 * attribute `slug=value` pairs; an attribute with several values names the first, as a product page selects one value
 * per attribute, SG-7); pairs whose value is empty are left out.
 * @param {string} template
 * @param {{ grade?: string | null, attributes?: Record<string, unknown> }} variant
 * @param {ReadonlyMap<string, { slug?: string }>} attributes by id
 */
export const variantQueryOf = (template, variant, attributes) => {
	if (!template) return '';
	const pairs = Object.entries(variant.attributes ?? {})
		.map(([id, value]) => {
			const slug = attributes.get(id)?.slug;
			const text = String((Array.isArray(value) ? value[0] : value) ?? '');
			return slug && text ? `${part(slug)}=${part(text)}` : '';
		})
		.filter(Boolean)
		.join('&');
	return template
		.replaceAll('{grade}', part(variant.grade ?? ''))
		.replaceAll('{attributes}', pairs)
		.split('&')
		.filter((pair) => pair !== '' && !/^[^=]+=$/.test(pair))
		.join('&');
};

/**
 * A variant's page: the product's page with the variant query.
 * @param {string} productUrl
 * @param {string} query
 */
export const withQuery = (productUrl, query) =>
	query ? `${productUrl}${productUrl.includes('?') ? '&' : '?'}${query}` : productUrl;

/**
 * The earlier slugs after a slug change: the old slug first, the new one never listed, at most 20.
 * @param {string[] | undefined} previous
 * @param {string} before the slug until now
 * @param {string} after the new slug
 */
export const nextPreviousSlugs = (previous, before, after) =>
	before === after
		? (previous ?? [])
		: [before, ...(previous ?? []).filter((slug) => slug !== before && slug !== after)].slice(0, MAX_PREVIOUS_SLUGS);

/**
 * A reference from a path, as slug lookups take it: ids as given, slugs in lower case.
 * @param {string} ref
 * @param {string} prefix the id prefix of the records
 */
export const normalRef = (ref, prefix) => (ref.startsWith(`${prefix}_`) ? ref : ref.toLowerCase());
