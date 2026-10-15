/**
 * The SEO health report of the live website (SEO audit §3.2 B; PLAN 0.8.9 SEO checklist): which pages one run reads
 * (the merchant's own paths, and sample pages picked from the sitemap: a product, a category, a landing or listing page
 * and a glossary page when the site has them), what kind each page is (from its structured data), and every check with
 * its status (pass, warn or fail), its finding (a stable code that names the widget text of the reason) and the figures
 * the texts name. Pure: the fetching and the database reads are done by the caller.
 * @module
 */
import { VITALS, ratingOf } from './events.js';
import { allNodesOf, numbersIn, robotsAllows, robotsGroupsOf, scanHtml, typesOf } from './seo-scan.js';
import { pathOfUrl } from './seo.js';

/** The merchant's own pages one run reads at most (the home page included). */
const MAX_PAGES = 20;

/** Sitemap addresses one run reads to find the sample pages. */
export const MAX_CANDIDATES = 6;

/** The kinds of page a run tells apart. */
export const PAGE_KINDS = Object.freeze(/** @type {const} */ (['home', 'product', 'category', 'listing', 'glossary', 'page']));

/** The kinds of page sampled from the sitemap, in the report's order. */
export const SAMPLE_KINDS = Object.freeze(/** @type {const} */ (['product', 'category', 'listing', 'glossary']));

/** Title and description lengths search results show without cutting. */
const TITLE_LENGTH = Object.freeze({ min: 10, max: 60 });
const DESCRIPTION_LENGTH = Object.freeze({ min: 50, max: 160 });

/** Fewest Web Vitals measurements a judgment is made on. */
const MIN_VITAL_SAMPLES = 5;

/** The Core Web Vitals (Google's page experience), judged by the share of good visits (at least 75 %). */
const CORE_VITALS = Object.freeze(/** @type {const} */ (['LCP', 'INP', 'CLS']));
const GOOD_SHARE = 75;

/**
 * Every check and its findings (the reason texts are the widget texts `seo.check.<id>.<finding>`). Checks of the whole
 * site first, then the checks of each page.
 */
export const CHECKS = Object.freeze({
	robots_txt: ['ok', 'not_text', 'missing', 'redirect', 'error'],
	robots_sitemap: ['ok', 'none'],
	robots_blocks: ['ok', 'blocked'],
	sitemap: ['ok', 'missing', 'invalid', 'empty', 'too_large', 'file_missing'],
	sitemap_urls: ['ok', 'bad', 'other_host'],
	soft_404: ['ok', 'moved', 'soft', 'redirect', 'error'],
	redirects_live: ['ok', 'not_applied'],
	redirect_suggestions: ['none', 'some'],
	verification: ['ok', 'none'],
	web_vitals_site: ['ok', 'needs_improvement', 'poor'],
	reachable: ['ok', 'redirect', 'not_found', 'error', 'timeout', 'too_large', 'unreachable', 'not_read'],
	noindex: ['ok', 'noindex', 'in_sitemap'],
	title: ['ok', 'missing', 'short', 'long'],
	description: ['ok', 'missing', 'short', 'long'],
	h1: ['ok', 'missing', 'several'],
	canonical: ['ok', 'missing', 'several', 'relative', 'other_host', 'other_page', 'not_self', 'invalid'],
	lang: ['ok', 'missing'],
	viewport: ['ok', 'missing'],
	social: ['ok', 'missing'],
	image_alt: ['ok', 'missing'],
	image_size: ['ok', 'missing'],
	structured_data: ['ok', 'none', 'invalid'],
	site_data: ['ok', 'missing'],
	product_data: ['ok', 'incomplete', 'partial'],
	price_match: ['ok', 'not_shown'],
	server_html: ['ok', 'missing'],
	breadcrumbs: ['ok', 'missing'],
	response_time: ['ok', 'slow', 'very_slow'],
	caching: ['ok', 'none', 'no_store'],
	web_vitals: ['ok', 'needs_improvement', 'poor'],
});

/** @typedef {keyof typeof CHECKS} CheckId */

/** The checks of the whole site (the others belong to a page). */
export const SITE_CHECKS = Object.freeze(
	/** @type {CheckId[]} */ ([
		'robots_txt',
		'robots_sitemap',
		'robots_blocks',
		'sitemap',
		'sitemap_urls',
		'soft_404',
		'redirects_live',
		'redirect_suggestions',
		'verification',
		'web_vitals_site',
	]),
);

/** @typedef {'pass' | 'warn' | 'fail'} CheckStatus */
/** @typedef {Record<string, string | number>} Detail */
/** @typedef {{ id: CheckId, status: CheckStatus, finding: string, page: string | null, detail: Detail }} Check */
/** @typedef {'timeout' | 'too_large' | 'unreachable' | 'time'} ReadError */
/**
 * A read of the website: the status (null: no answer, see `error`), the headers (lower-case names), the body, the time
 * it took (ms, null when not measured) and why it failed.
 * @typedef {{ url: string, status: number | null, headers: Record<string, string>, body: string, ms: number | null,
 *   error: ReadError | null }} Fetched
 */
/** @typedef {(typeof PAGE_KINDS)[number]} PageKind */

/**
 * @param {CheckId} id
 * @param {CheckStatus} status
 * @param {string} finding
 * @param {string | null} page
 * @param {Detail} [detail]
 * @returns {Check}
 */
const check = (id, status, finding, page, detail = {}) => ({ id, status, finding, page, detail });

/**
 * Google's Rich Results Test of a page.
 * @param {string} url
 */
export const richResultsTestOf = (url) => `https://search.google.com/test/rich-results?url=${encodeURIComponent(url)}`;

/**
 * An address as compared with another (the sitemap's, a page's, a canonical link's): without its fragment; the text
 * itself when it is not an address.
 * @param {string} url
 */
export const comparableOf = (url) => {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
	} catch {
		return url;
	}
};

// --------------------------------------------------------------------------------------------------------- pages

/**
 * The merchant's own pages one run reads: the paths asked for (else the `seo_checklist` settings), as addresses of the
 * website, the home page first, at most {@link MAX_PAGES}.
 * @param {unknown} paths
 * @param {string} domain
 */
export const pagesOf = (paths, domain) => {
	const list = (Array.isArray(paths) ? paths : [])
		.filter((path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/\s/.test(path))
		.map((path) => `https://${domain}${path}`);
	return [...new Set([`https://${domain}/`, ...list])].slice(0, MAX_PAGES);
};

/**
 * Sitemap addresses worth reading to find the sample pages (at most `limit`, never the home page or a page already
 * read, only https addresses of the website): the first one with images (often a product), the first one with a query
 * string (often a landing page), then the first address of each group of addresses that share their first path
 * segment, the largest groups first (each kind of page usually has its own: /products/…, /categories/…, /glossary/…).
 * @param {ReadonlyArray<{ loc: string, images: number }>} entries in the sitemap's order
 * @param {{ domain: string, skip: ReadonlyArray<string>, limit?: number }} options
 * @returns {string[]}
 */
export const candidatesOf = (entries, { domain, skip, limit = MAX_CANDIDATES }) => {
	const taken = new Set(skip);
	/** @type {Array<{ url: string, images: number, query: boolean, group: string }>} */
	const valid = [];
	for (const entry of entries) {
		let url;
		try {
			url = new URL(entry.loc);
		} catch {
			continue;
		}
		if (url.protocol !== 'https:' || url.host !== domain || (url.pathname === '/' && url.search === '')) continue;
		const href = comparableOf(url.href);
		if (taken.has(href)) continue;
		taken.add(href);
		valid.push({
			url: href,
			images: entry.images,
			query: url.search !== '',
			group: `${url.pathname.split('/')[1] ?? ''}${url.search === '' ? '' : '?'}`,
		});
	}
	/** @type {string[]} */
	const picked = [];
	/** @param {{ url: string } | undefined} item */
	const add = (item) => {
		if (item && picked.length < limit && !picked.includes(item.url)) picked.push(item.url);
	};
	add(valid.find((item) => item.images > 0));
	add(valid.find((item) => item.query));
	/** @type {Map<string, { first: { url: string }, size: number }>} */
	const groups = new Map();
	for (const item of valid) {
		const group = groups.get(item.group);
		if (group) group.size += 1;
		else groups.set(item.group, { first: item, size: 1 });
	}
	for (const group of [...groups.values()].sort((a, b) => b.size - a.size)) add(group.first);
	return picked;
};

/** schema.org types of a collection page (a category, a landing page, a listing). */
const COLLECTION_TYPES = new Set(['CollectionPage', 'ItemList', 'SearchResultsPage', 'OfferCatalog']);
/** schema.org types of a glossary page. */
const GLOSSARY_TYPES = new Set(['DefinedTerm', 'DefinedTermSet']);
/** schema.org types of a product. */
const PRODUCT_TYPES = new Set(['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel']);
/** Organization types of the site data besides those ending in Organization, Store or Business. */
const ORGANIZATION_TYPES = new Set(['Corporation', 'NGO', 'Airline', 'Consortium', 'Restaurant', 'Hotel']);

/**
 * The main nodes of a page: its top-level nodes and the `mainEntity` of a top-level web page.
 * @param {Array<Record<string, unknown>>} top
 */
const mainNodesOf = (top) => [
	...top,
	...top.flatMap((node) => {
		const main = node.mainEntity;
		return (Array.isArray(main) ? main : [main]).filter(
			/** @returns {item is Record<string, unknown>} */ (item) => typeof item === 'object' && item !== null,
		);
	}),
];

/**
 * @param {Array<Record<string, unknown>>} nodes
 * @param {Set<string>} types
 */
const findType = (nodes, types) => nodes.find((node) => typesOf(node).some((type) => types.has(type))) ?? null;

/**
 * What kind of page an address is: the home page by its path; else by its main structured data: a product, a glossary
 * term, or a collection (a category; with a query string, a landing or listing page); any other page is `page`.
 * @param {string} url
 * @param {import('./seo-scan.js').Scan} scan
 * @returns {PageKind}
 */
export const kindOf = (url, scan) => {
	const parsed = new URL(url);
	if (parsed.pathname === '/' && parsed.search === '') return 'home';
	const main = mainNodesOf(scan.jsonLd.nodes);
	if (findType(main, PRODUCT_TYPES)) return 'product';
	if (findType(main, GLOSSARY_TYPES)) return 'glossary';
	if (findType(main, COLLECTION_TYPES)) return parsed.search === '' ? 'category' : 'listing';
	return 'page';
};

// ----------------------------------------------------------------------------------------------- structured data

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
const listOf = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

/**
 * The price of an offer (its `price`, `lowPrice` or price specification's `price`) as a number, or null.
 * @param {unknown} offer
 */
const priceOf = (offer) => {
	if (typeof offer !== 'object' || offer === null) return null;
	const node = /** @type {Record<string, any>} */ (offer);
	const specs = /** @type {any[]} */ (listOf(node.priceSpecification));
	const raw = node.price ?? node.lowPrice ?? specs.find((spec) => spec?.price !== undefined)?.price;
	const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
	return Number.isFinite(value) ? value : null;
};

/**
 * @param {unknown} offer
 * @returns {string | null}
 */
const currencyOf = (offer) => {
	if (typeof offer !== 'object' || offer === null) return null;
	const node = /** @type {Record<string, any>} */ (offer);
	const specs = /** @type {any[]} */ (listOf(node.priceSpecification));
	const raw = node.priceCurrency ?? specs.find((spec) => spec?.priceCurrency)?.priceCurrency;
	return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
};

/**
 * Whether a structured-data value is set (a non-empty text, or an object or list holding one).
 * @param {unknown} value
 */
const isSet = (value) =>
	typeof value === 'string'
		? value.trim() !== ''
		: Array.isArray(value)
			? value.some(isSet)
			: typeof value === 'object' && value !== null;

/**
 * The page's product as Google reads it for merchant listings: its name, its images, and each offer (of the product,
 * or of each variant of a product group) with its price, currency and availability.
 * @param {Array<Record<string, unknown>>} top
 */
export const productOf = (top) => {
	const node = findType(mainNodesOf(top), PRODUCT_TYPES);
	if (node === null) return null;
	const variants = typesOf(node).includes('ProductGroup')
		? listOf(node.hasVariant).filter(
				/** @returns {item is Record<string, unknown>} */ (item) => typeof item === 'object' && item !== null,
			)
		: [node];
	const offers = variants
		.slice(0, 50)
		.flatMap((variant) => (listOf(variant.offers).length > 0 ? listOf(variant.offers) : [null]));
	return {
		name: typeof node.name === 'string' ? node.name.trim() : '',
		image: isSet(node.image) || variants.some((variant) => isSet(variant.image)),
		images: [node, ...variants].flatMap((item) =>
			listOf(item.image).map((image) =>
				typeof image === 'string'
					? image
					: typeof image === 'object' && image !== null
						? String(/** @type {any} */ (image).url ?? '')
						: '',
			),
		),
		offers: offers.map((offer) => ({
			price: priceOf(offer),
			currency: currencyOf(offer),
			availability: typeof offer === 'object' && offer !== null && isSet(/** @type {any} */ (offer).availability),
		})),
	};
};

/**
 * Whether a page's structured data has a node of one of these types (anywhere, nested ones included).
 * @param {Array<Record<string, unknown>>} top
 * @param {(type: string) => boolean} test
 */
const hasType = (top, test) => allNodesOf(top).some((node) => typesOf(node).some(test));

/** @param {string} type */
const isOrganization = (type) => ORGANIZATION_TYPES.has(type) || /(?:Organization|Store|Business)$/.test(type);

// ----------------------------------------------------------------------------------------------------- page checks

/**
 * A price as written in the report (`1250`, `12.5` → `1250.00`, `12.50`).
 * @param {number} value
 */
const priceText = (value) => (Number.isInteger(value * 100) ? value.toFixed(2) : String(value));

/**
 * The checks of one page that answered 200.
 * @param {Fetched} page
 * @param {import('./seo-scan.js').Scan} scan
 * @param {{ domain: string, kind: PageKind, listed: boolean }} context `listed`: the sitemap lists the page
 * @returns {Check[]}
 */
const contentChecks = (page, scan, { domain, kind, listed }) => {
	const at = page.url;
	const header = (page.headers['x-robots-tag'] ?? '').toLowerCase();
	const titleLength = scan.title?.length ?? 0;
	const descriptionLength = scan.description?.trim().length ?? 0;
	/** @type {Check[]} */
	const checks = [
		/\b(?:noindex|none)\b/.test(scan.robots) || /\b(?:noindex|none)\b/.test(header)
			? check('noindex', 'fail', listed ? 'in_sitemap' : 'noindex', at)
			: check('noindex', 'pass', 'ok', at),
		titleLength === 0
			? check('title', 'fail', 'missing', at, { length: 0 })
			: check(
					'title',
					titleLength < TITLE_LENGTH.min || titleLength > TITLE_LENGTH.max ? 'warn' : 'pass',
					titleLength < TITLE_LENGTH.min ? 'short' : titleLength > TITLE_LENGTH.max ? 'long' : 'ok',
					at,
					{ length: titleLength },
				),
		check(
			'description',
			descriptionLength >= DESCRIPTION_LENGTH.min && descriptionLength <= DESCRIPTION_LENGTH.max ? 'pass' : 'warn',
			descriptionLength === 0
				? 'missing'
				: descriptionLength < DESCRIPTION_LENGTH.min
					? 'short'
					: descriptionLength > DESCRIPTION_LENGTH.max
						? 'long'
						: 'ok',
			at,
			{ length: descriptionLength },
		),
		check('h1', scan.h1 === 1 ? 'pass' : 'warn', scan.h1 === 0 ? 'missing' : scan.h1 === 1 ? 'ok' : 'several', at, {
			count: scan.h1,
		}),
		canonicalCheck(at, scan.canonicals, { domain, listed }),
		check('lang', scan.lang ? 'pass' : 'warn', scan.lang ? 'ok' : 'missing', at),
		check('viewport', scan.viewport ? 'pass' : 'fail', scan.viewport ? 'ok' : 'missing', at),
		check('social', scan.ogTitle && scan.ogImage ? 'pass' : 'warn', scan.ogTitle && scan.ogImage ? 'ok' : 'missing', at),
		check('image_alt', scan.imagesWithoutAlt === 0 ? 'pass' : 'warn', scan.imagesWithoutAlt === 0 ? 'ok' : 'missing', at, {
			count: scan.imagesWithoutAlt,
		}),
		check('image_size', scan.imagesWithoutSize === 0 ? 'pass' : 'warn', scan.imagesWithoutSize === 0 ? 'ok' : 'missing', at, {
			count: scan.imagesWithoutSize,
		}),
		scan.jsonLd.invalid > 0
			? check('structured_data', 'fail', 'invalid', at, { count: scan.jsonLd.invalid })
			: check('structured_data', scan.jsonLd.blocks > 0 ? 'pass' : 'warn', scan.jsonLd.blocks > 0 ? 'ok' : 'none', at, {
					count: scan.jsonLd.blocks,
				}),
	];
	const top = scan.jsonLd.nodes;
	if (kind === 'home') {
		const missing = [
			hasType(top, isOrganization) ? null : 'Organization',
			hasType(top, (type) => type === 'WebSite') ? null : 'WebSite',
		].filter((name) => name !== null);
		checks.push(
			missing.length === 0
				? check('site_data', 'pass', 'ok', at)
				: check('site_data', 'warn', 'missing', at, { missing: missing.join(', ') }),
		);
	}
	if (kind === 'product') checks.push(...productChecks(at, scan));
	if (kind === 'product' || kind === 'category' || kind === 'listing')
		checks.push(
			hasType(top, (type) => type === 'BreadcrumbList')
				? check('breadcrumbs', 'pass', 'ok', at)
				: check('breadcrumbs', 'warn', 'missing', at),
		);
	return checks;
};

/**
 * The canonical link of a page: exactly one (or several of one address), absolute, on the website, and the page itself
 * for a page the sitemap lists (another page of the website is a warning on other pages: right for a copy, wrong for
 * a page meant for search results).
 * @param {string} at
 * @param {string[]} canonicals
 * @param {{ domain: string, listed: boolean }} context
 */
const canonicalCheck = (at, canonicals, { domain, listed }) => {
	const distinct = [...new Set(canonicals)];
	if (distinct.length === 0) return check('canonical', 'warn', 'missing', at);
	if (distinct.length > 1) return check('canonical', 'fail', 'several', at, { count: distinct.length });
	const href = /** @type {string} */ (distinct[0]);
	let url;
	try {
		url = new URL(href, at);
	} catch {
		return check('canonical', 'fail', 'invalid', at, { url: href });
	}
	if (!/^https?:\/\//i.test(href)) return check('canonical', 'warn', 'relative', at, { url: href });
	if (url.host !== domain) return check('canonical', 'warn', 'other_host', at, { url: href });
	if (comparableOf(url.href) === comparableOf(at)) return check('canonical', 'pass', 'ok', at, { url: href });
	return listed
		? check('canonical', 'fail', 'not_self', at, { url: href })
		: check('canonical', 'warn', 'other_page', at, { url: href });
};

/**
 * The checks of a product page (merchant listings): its structured data names the product, its images and offers with
 * price, currency and availability; the page shows that price and the product's name in the HTML the server sends.
 * @param {string} at
 * @param {import('./seo-scan.js').Scan} scan
 * @returns {Check[]}
 */
const productChecks = (at, scan) => {
	const product = /** @type {NonNullable<ReturnType<typeof productOf>>} */ (productOf(scan.jsonLd.nodes));
	const required = [
		product.name === '' ? 'name' : null,
		product.offers.every((offer) => offer.price === null) ? 'offers.price' : null,
		product.offers.every((offer) => offer.currency === null) ? 'offers.priceCurrency' : null,
	].filter((name) => name !== null);
	const recommended = [
		product.image ? null : 'image',
		product.offers.every((offer) => offer.availability) ? null : 'offers.availability',
	].filter((name) => name !== null);
	/** @type {Check[]} */
	const checks = [
		required.length > 0
			? check('product_data', 'fail', 'incomplete', at, { missing: [...required, ...recommended].join(', ') })
			: recommended.length > 0
				? check('product_data', 'warn', 'partial', at, { missing: recommended.join(', ') })
				: check('product_data', 'pass', 'ok', at),
	];
	const priced = product.offers.filter((offer) => offer.price !== null);
	const first = priced[0];
	if (first) {
		const shown = numbersIn(scan.text);
		const found = priced.find((offer) => shown.some((value) => Math.abs(value - Number(offer.price)) < 0.005));
		const offer = found ?? first;
		checks.push(
			check('price_match', found ? 'pass' : 'fail', found ? 'ok' : 'not_shown', at, {
				price: priceText(Number(offer.price)),
				currency: offer.currency ?? '',
			}),
		);
	}
	if (product.name !== '') {
		const name = product.name.replace(/\s+/g, ' ').toLowerCase();
		checks.push(
			scan.text.toLowerCase().includes(name)
				? check('server_html', 'pass', 'ok', at, { name: product.name })
				: check('server_html', 'fail', 'missing', at, { name: product.name }),
		);
	}
	return checks;
};

/**
 * How fast the page answered our read (Google's server response time thresholds, the TTFB of Web Vitals) and whether
 * it gives search engines a validator to read it again cheaply (an ETag or Last-Modified header, Google's crawlers ask
 * with If-None-Match or If-Modified-Since) that a cache may keep: `Cache-Control: no-store` keeps nothing, so every
 * read downloads the whole page again.
 * @param {Fetched} page
 * @returns {Check[]}
 */
const speedChecks = (page) => {
	const [good = 0, poor = 0] = VITALS.TTFB;
	const ms = page.ms === null ? null : Math.round(page.ms);
	const cacheControl = (page.headers['cache-control'] ?? '').trim();
	return [
		...(ms === null
			? []
			: [
					check(
						'response_time',
						ms <= good ? 'pass' : ms <= poor ? 'warn' : 'fail',
						ms <= good ? 'ok' : ms <= poor ? 'slow' : 'very_slow',
						page.url,
						{ ms },
					),
				]),
		/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)
			? check('caching', 'warn', 'no_store', page.url, { cacheControl: cacheControl.slice(0, 200) })
			: page.headers.etag || page.headers['last-modified']
				? check('caching', 'pass', 'ok', page.url)
				: check('caching', 'warn', 'none', page.url),
	];
};

/**
 * Whether the page answered, and why not: a redirect (a failure for a page the sitemap lists), missing, an error, or
 * no answer.
 * @param {Fetched} page
 * @param {boolean} listed
 */
const reachableCheck = (page, listed) => {
	const at = page.url;
	const status = page.status;
	if (status === 200)
		return check('reachable', 'pass', 'ok', at, { status, ...(page.ms === null ? {} : { ms: Math.round(page.ms) }) });
	if (status === null)
		return page.error === 'time'
			? check('reachable', 'warn', 'not_read', at, { status: 0 })
			: check('reachable', 'fail', page.error ?? 'unreachable', at, { status: 0 });
	if (status >= 300 && status < 400)
		return check('reachable', listed ? 'fail' : 'warn', 'redirect', at, {
			status,
			location: page.headers.location ?? '',
		});
	return check('reachable', 'fail', status === 404 || status === 410 ? 'not_found' : 'error', at, { status });
};

/**
 * The checks of one page: whether it answered, then (when it did) its content, its structured data by kind, its speed,
 * and its Web Vitals (pages like it, when measured).
 * @param {Fetched} page
 * @param {{ domain: string, listed: boolean, vitals?: PageVitals | null }} context
 * @returns {{ kind: PageKind, checks: Check[], scan: import('./seo-scan.js').Scan | null }}
 */
export const pageChecks = (page, { domain, listed, vitals = null }) => {
	const reachable = reachableCheck(page, listed);
	if (page.status !== 200) {
		const parsed = new URL(page.url);
		return { kind: parsed.pathname === '/' && parsed.search === '' ? 'home' : 'page', checks: [reachable], scan: null };
	}
	const scan = scanHtml(page.body);
	const kind = kindOf(page.url, scan);
	return {
		kind,
		scan,
		checks: [
			reachable,
			...contentChecks(page, scan, { domain, kind, listed }),
			...speedChecks(page),
			...(vitals ? [vitalsCheck(page.url, vitals)] : []),
		],
	};
};

// ---------------------------------------------------------------------------------------------------- Web Vitals

/** @typedef {{ pattern: string, samples: number, averages: Partial<Record<'LCP' | 'INP' | 'CLS', number>> }} PageVitals */

/**
 * The pages a page's Web Vitals are taken from: the home page itself, else every page at its level under the same path
 * (`/products/blue-lamp` → `/products/*`), so a product page is judged with the product pages.
 * @param {string} path the page's path (no query string)
 */
export const patternOf = (path) => (path === '/' ? '/' : `${path.slice(0, path.lastIndexOf('/'))}/*`);

/**
 * Whether a path is one of a pattern's pages: the home page itself, else a page at that level under its path.
 * @param {string} pattern from {@link patternOf}
 * @param {string} path
 */
const inPattern = (pattern, path) => {
	if (pattern === '/') return path === '/';
	const base = pattern.slice(0, -1);
	return path.startsWith(base) && path.length > base.length && !path.slice(base.length).includes('/');
};

/**
 * The average Web Vitals of the pages of a pattern, from the per-page totals (`vital_page`, kept with the sessions
 * detail): null when fewer than {@link MIN_VITAL_SAMPLES} measurements of a core vital were made.
 * @param {ReadonlyArray<{ metric: string, key: string, count: number, sum: number }>} rows
 * @param {string} path the page's path
 * @returns {PageVitals | null}
 */
export const pageVitalsOf = (rows, path) => {
	const pattern = patternOf(path);
	/** @type {Record<string, { count: number, sum: number }>} */
	const sums = {};
	for (const row of rows) {
		if (row.metric !== 'vital_page') continue;
		const cut = row.key.lastIndexOf('\n');
		const at = row.key.slice(0, cut);
		const name = row.key.slice(cut + 1);
		if (!inPattern(pattern, at) || !CORE_VITALS.includes(/** @type {any} */ (name))) continue;
		const total = (sums[name] ??= { count: 0, sum: 0 });
		total.count += row.count;
		total.sum += row.sum;
	}
	const judged = Object.entries(sums).filter(([, total]) => total.count >= MIN_VITAL_SAMPLES);
	if (judged.length === 0) return null;
	return {
		pattern,
		samples: Math.max(...judged.map(([, total]) => total.count)),
		averages: Object.fromEntries(judged.map(([name, total]) => [name, Math.round(total.sum / total.count)])),
	};
};

/**
 * A vital's value as the texts show it (`2.6 s`, `180 ms`, `0.12`).
 * @param {'LCP' | 'INP' | 'CLS'} name
 * @param {number} value ms, CLS × 1000
 */
const vitalText = (name, value) =>
	name === 'CLS' ? (value / 1000).toFixed(2) : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;

/**
 * The Web Vitals check of a page (the averages of the pages like it, each rated by web.dev's thresholds): the worst
 * one decides.
 * @param {string} at
 * @param {PageVitals} vitals
 * @returns {Check}
 */
const vitalsCheck = (at, vitals) => {
	const rated = CORE_VITALS.filter((name) => vitals.averages[name] !== undefined).map((name) => ({
		name,
		value: /** @type {number} */ (vitals.averages[name]),
		rating: ratingOf(name, /** @type {number} */ (vitals.averages[name])),
	}));
	const order = { poor: 0, needs_improvement: 1, good: 2 };
	const worst = /** @type {(typeof rated)[number]} */ ([...rated].sort((a, b) => order[a.rating] - order[b.rating])[0]);
	const detail = {
		pattern: vitals.pattern,
		samples: vitals.samples,
		vital: worst.name,
		value: vitalText(worst.name, worst.value),
	};
	return worst.rating === 'good'
		? check('web_vitals', 'pass', 'ok', at, detail)
		: check('web_vitals', worst.rating === 'poor' ? 'fail' : 'warn', worst.rating, at, detail);
};

/**
 * The website's Core Web Vitals over the visits measured (the daily `vital` totals, rated per visit), judged as Google
 * does: each vital passes when at least 75 % of its visits were good; a vital with more than 25 % poor visits fails.
 * Null when fewer than {@link MIN_VITAL_SAMPLES} visits of each were measured.
 * @param {ReadonlyArray<{ metric: string, key: string, count: number }>} rows
 * @returns {Check | null}
 */
export const siteVitalsCheck = (rows) => {
	const judged = CORE_VITALS.map((name) => {
		/** @param {string} rating */
		const count = (rating) =>
			rows.filter((row) => row.metric === 'vital' && row.key === `${name}:${rating}`).reduce((sum, row) => sum + row.count, 0);
		const good = count('good');
		const poor = count('poor');
		const total = good + poor + count('needs_improvement');
		return {
			name,
			total,
			good: total === 0 ? 0 : Math.round((good / total) * 100),
			poor: total === 0 ? 0 : (poor / total) * 100,
		};
	}).filter((vital) => vital.total >= MIN_VITAL_SAMPLES);
	if (judged.length === 0) return null;
	const worst = /** @type {(typeof judged)[number]} */ ([...judged].sort((a, b) => a.good - b.good)[0]);
	const samples = judged.reduce((sum, vital) => Math.max(sum, vital.total), 0);
	if (judged.some((vital) => vital.poor > 100 - GOOD_SHARE)) {
		const poorest = /** @type {(typeof judged)[number]} */ ([...judged].sort((a, b) => b.poor - a.poor)[0]);
		return check('web_vitals_site', 'fail', 'poor', null, { vital: poorest.name, good: poorest.good, samples });
	}
	return worst.good >= GOOD_SHARE
		? check('web_vitals_site', 'pass', 'ok', null, { samples })
		: check('web_vitals_site', 'warn', 'needs_improvement', null, { vital: worst.name, good: worst.good, samples });
};

// ----------------------------------------------------------------------------------------------------- site checks

/**
 * Whether the robots.txt presets keep a path out on purpose (G12), as Google reads them: a page of the checklist's own
 * that they keep out is not one robots.txt must let Google read.
 * @param {ReadonlyArray<string>} presets the presets' Disallow lines
 * @returns {(path: string) => boolean}
 */
export const keptOutBy = (presets) => {
	const groups = robotsGroupsOf(['User-agent: *', ...presets].join('\n'));
	return (path) => !robotsAllows(groups, ['googlebot'], path).allowed;
};

/**
 * The robots.txt checks: it answers with plain text (a server error stops Google crawling the site; an HTML page in its
 * place, as a site that answers every address with its app gives, has no rules), it names a sitemap, and it lets
 * Google read the home page, the sitemap, every page read and the product images.
 * @param {Fetched} robots
 * @param {{ paths: Array<{ path: string, image?: boolean }> }} input the paths to try, images with Googlebot-Image
 * @returns {Check[]}
 */
export const robotsChecks = (robots, { paths }) => {
	const at = robots.url;
	const status = robots.status;
	const answered =
		status === 200
			? /^\s*<(?:!doctype|html)\b/i.test(robots.body)
				? check('robots_txt', 'warn', 'not_text', at, { status })
				: check('robots_txt', 'pass', 'ok', at, { status })
			: status !== null && status >= 300 && status < 400
				? check('robots_txt', 'warn', 'redirect', at, { status, location: robots.headers.location ?? '' })
				: status !== null && status >= 400 && status < 500
					? check('robots_txt', 'warn', 'missing', at, { status })
					: check('robots_txt', 'fail', 'error', at, { status: status ?? 0 });
	if (status !== 200) return [answered, check('robots_sitemap', 'warn', 'none', at)];
	const named = robots.body.split(/\r?\n|\r/).filter((line) => /^\s*sitemap\s*:\s*\S/i.test(line)).length;
	const groups = robotsGroupsOf(robots.body);
	const blocked = paths
		.map(({ path, image }) => ({
			path,
			...robotsAllows(groups, image ? ['googlebot-image', 'googlebot'] : ['googlebot'], path),
		}))
		.filter((verdict) => !verdict.allowed);
	const first = blocked[0];
	return [
		answered,
		named > 0 ? check('robots_sitemap', 'pass', 'ok', at, { count: named }) : check('robots_sitemap', 'warn', 'none', at),
		first
			? check('robots_blocks', 'fail', 'blocked', at, { count: blocked.length, path: first.path, rule: first.rule ?? '' })
			: check('robots_blocks', 'pass', 'ok', at, { count: paths.length }),
	];
};

/**
 * The sitemap check: it answers, is a sitemap, lists addresses and every file of an index answers.
 * @param {{ read: Fetched, type: 'index' | 'urlset' | null, entries: number, files: Fetched[] }} sitemap
 * @returns {Check}
 */
export const sitemapCheck = ({ read, type, entries, files }) => {
	const at = read.url;
	if (read.status === null && read.error === 'too_large') return check('sitemap', 'warn', 'too_large', at);
	if (read.status !== 200) return check('sitemap', 'warn', 'missing', at, { status: read.status ?? 0 });
	if (type === null) return check('sitemap', 'fail', 'invalid', at);
	const broken = files.find((file) => file.status !== 200);
	if (broken) return check('sitemap', 'fail', 'file_missing', at, { path: pathOfUrl(broken.url), status: broken.status ?? 0 });
	if (entries === 0) return check('sitemap', 'warn', 'empty', at);
	return check('sitemap', 'pass', 'ok', at, { count: entries });
};

/**
 * The addresses of the sitemap: those read answer 200 themselves (never a redirect or an error), and every address is
 * an https address of the website.
 * @param {{ reads: Fetched[], entries: ReadonlyArray<{ loc: string }>, domain: string }} input
 * @returns {Check | null} null when no address was read
 */
export const sitemapUrlsCheck = ({ reads, entries, domain }) => {
	if (reads.length === 0) return null;
	const bad = reads.filter((read) => read.status !== 200);
	const first = bad[0];
	if (first)
		return check('sitemap_urls', 'fail', 'bad', null, {
			count: bad.length,
			path: pathOfUrl(first.url),
			status: first.status ?? 0,
		});
	const elsewhere = entries.filter((entry) => {
		try {
			const url = new URL(entry.loc);
			return url.protocol !== 'https:' || url.host !== domain;
		} catch {
			return true;
		}
	});
	const outside = elsewhere[0];
	return outside
		? check('sitemap_urls', 'warn', 'other_host', null, { count: elsewhere.length, url: outside.loc })
		: check('sitemap_urls', 'pass', 'ok', null, { count: reads.length });
};

/**
 * A real removed product's address to try as the missing page (SEO audit §3.2 B: a missing product answers 404 or
 * 410): of the 404 log (visitors reached the site's not-found page there), the most visited address at the level of a
 * product page the run read (`/products/*` for `/products/blue-lamp`) that is not a page read, the sitemap does not
 * list and no redirect rule answers (those are tried as rules); null when there is none.
 * @param {{ notFound: ReadonlyArray<{ metric: string, key: string, count: number }>, products: string[],
 *   listed: Set<string>, answered: (path: string) => boolean, origin: string }} input `products`: the paths of the
 *   product pages read; `listed`: the sitemap's addresses ({@link comparableOf}); `answered`: a rule answers the path
 * @returns {{ url: string, pattern: string } | null}
 */
export const removedProductOf = ({ notFound, products, listed, answered, origin }) => {
	const patterns = [...new Set(products.map(patternOf))];
	const found = notFound
		.filter((row) => row.metric === 'not_found' && !products.includes(row.key))
		.map((row) => ({ ...row, pattern: patterns.find((pattern) => inPattern(pattern, row.key)) }))
		.filter((row) => row.pattern !== undefined && !listed.has(`${origin}${row.key}`) && !answered(row.key))
		.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))[0];
	return found ? { url: `${origin}${found.key}`, pattern: /** @type {string} */ (found.pattern) } : null;
};

/**
 * An address the website does not have answers 404 or 410: a 200 is a soft 404 (search engines index an empty page),
 * a redirect sends lost visitors and search engines elsewhere (Google treats a removed page sent to an unrelated one,
 * such as its category or the home page, as a soft 404). A removed product (`pattern`: the level of its product pages)
 * may also be sent on permanently (301 or 308) to another product page of the website, its replacement.
 * @param {Fetched} probe
 * @param {string | null} [pattern] for a removed product, the pattern of the product pages ({@link patternOf})
 * @returns {Check | null} null when the run's time was up before it was read (nothing to judge)
 */
export const soft404Check = (probe, pattern = null) => {
	if (probe.error === 'time') return null;
	const status = probe.status;
	const path = pathOfUrl(probe.url);
	if (status === 404 || status === 410) return check('soft_404', 'pass', 'ok', probe.url, { status, path });
	if (status === 200) return check('soft_404', 'fail', 'soft', probe.url, { status, path });
	if (status !== null && status >= 300 && status < 400) {
		const location = probe.headers.location ?? '';
		/** @type {URL | null} */
		let target = null;
		try {
			target = new URL(location, probe.url);
		} catch {
			// not an address: a redirect to nowhere
		}
		const replaced =
			pattern !== null &&
			(status === 301 || status === 308) &&
			target !== null &&
			target.host === new URL(probe.url).host &&
			inPattern(pattern, target.pathname);
		return check('soft_404', replaced ? 'pass' : 'warn', replaced ? 'moved' : 'redirect', probe.url, {
			status,
			location,
			path,
		});
	}
	return check('soft_404', 'fail', 'error', probe.url, { status: status ?? 0, path });
};

/**
 * Old paths with a redirect rule answer it on the live site: a redirect of the rule's kind to the rule's address
 * (permanent 301 or 308, or temporary 302 or 307, G14), or gone (410; 404 counts the same for search engines).
 * @param {Array<{ read: Fetched, code: number, location: string | null }>} probes each rule's old path as read, with
 *   what its rule answers
 * @param {string} origin the website's `https://<domain>`
 * @returns {Check | null} null when no rule was tried
 */
export const redirectsLiveCheck = (probes, origin) => {
	if (probes.length === 0) return null;
	const wrong = probes.filter(({ read, code, location }) => {
		if (code === 410) return read.status !== 410 && read.status !== 404;
		const kind = code === 301 || code === 308 ? [301, 308] : [302, 307];
		if (read.status === null || !kind.includes(read.status)) return true;
		try {
			return new URL(read.headers.location ?? '', read.url).href !== new URL(String(location), origin).href;
		} catch {
			return true;
		}
	});
	const first = wrong[0];
	return first
		? check('redirects_live', 'fail', 'not_applied', null, {
				count: wrong.length,
				path: pathOfUrl(first.read.url),
				status: first.read.status ?? 0,
				expected: first.code,
			})
		: check('redirects_live', 'pass', 'ok', null, { count: probes.length });
};

/**
 * The 404 log: the addresses visitors could not find that no redirect rule answers yet.
 * @param {Array<{ path: string, hits: number }>} suggestions most hits first
 * @returns {Check}
 */
export const suggestionsCheck = (suggestions) => {
	const top = suggestions[0];
	return top
		? check('redirect_suggestions', 'warn', 'some', null, { count: suggestions.length, path: top.path, hits: top.hits })
		: check('redirect_suggestions', 'pass', 'none', null);
};

/**
 * The home page carries a search engine's verification tag.
 * @param {Fetched} home
 * @param {import('./seo-scan.js').Scan} scan
 * @returns {Check}
 */
export const verificationCheck = (home, scan) =>
	scan.verification.length > 0
		? check('verification', 'pass', 'ok', home.url, { count: scan.verification.length })
		: check('verification', 'warn', 'none', home.url, { count: 0 });

// --------------------------------------------------------------------------------------------------------- report

/**
 * The counts of a report's checks.
 * @param {ReadonlyArray<{ status: CheckStatus }>} checks
 */
export const summaryOf = (checks) => ({
	pass: checks.filter((c) => c.status === 'pass').length,
	warn: checks.filter((c) => c.status === 'warn').length,
	fail: checks.filter((c) => c.status === 'fail').length,
});
