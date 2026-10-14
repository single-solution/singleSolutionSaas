/**
 * The website Setup sheet (`ss.blueprint/1`; design `audit/design/website-blueprint.md`), pure parts: the sheet from
 * the website's facts and each product's answer, the copy a share link shows, and the input of a new share link.
 * @module
 */
import { BLUEPRINT_SCHEMA } from '@ss/contracts';

/** @typedef {import('@ss/contracts').Blueprint} Blueprint */
/** @typedef {import('@ss/contracts').ProductBlueprint} ProductBlueprint */
/** @typedef {Blueprint['products'][number]} SheetProduct */
/** @typedef {'timeout' | 'unreachable' | 'refused' | 'invalid'} Unreachable */
/**
 * A product on the website as the Portal knows it (Install and tokens).
 * @typedef {{ productId: string, name: string, browserToken: string }} InstallEntry
 */

/** A share link lasts this many days unless its creator chooses 1 to 30. */
export const SHARE_DAYS_DEFAULT = 7;
export const SHARE_DAYS_MAX = 30;
/** Hosts a browser token also works from, on any port over http or https: for testing on one's own computer. */
export const TESTING_HOSTS = Object.freeze(['localhost', '*.localhost', '127.0.0.1', '[::1]']);
/** What the sheet says about server tokens (never their values). */
export const SERVER_TOKENS_NOTE =
	'A server token is issued for each product. It is never shown here: reveal it in the Portal (Install and tokens) and keep it on your server only.';

/**
 * The widget script tag of a product with widgets (PLAN 0.4.10), with the browser token filled in.
 * @param {string} scriptUrl
 * @param {string} browserToken
 */
export const scriptTag = (scriptUrl, browserToken) => `<script src="${scriptUrl}" data-token="${browserToken}" async></script>`;

/**
 * A product's entry: its answer with the Portal's install facts, or why it is missing.
 * @param {InstallEntry} entry
 * @param {{ ok: true, blueprint: ProductBlueprint } | { ok: false, reason: Unreachable }} answer
 * @returns {SheetProduct}
 */
export const productEntry = (entry, answer) => {
	if (!answer.ok) return { productId: entry.productId, name: entry.name, reachable: false, reason: answer.reason };
	const { install, ...rest } = answer.blueprint;
	return {
		...rest,
		reachable: true,
		install: {
			...install,
			browserToken: entry.browserToken,
			snippet: install.scriptUrl === null ? null : scriptTag(install.scriptUrl, entry.browserToken),
		},
		serverToken: { issued: true },
	};
};

/**
 * The sheet of a website.
 * @param {{ websiteId: string, domain: string, products: SheetProduct[], now: number }} input
 * @returns {Blueprint}
 */
export const assembleSheet = ({ websiteId, domain, products, now }) => {
	const found = products.find((p) => p.reachable && p.business.found);
	const business = found?.reachable
		? { found: true, name: found.business.name, country: found.business.country, timeZone: found.business.timeZone }
		: { found: false, name: null, country: null, timeZone: null };
	return {
		schema: BLUEPRINT_SCHEMA,
		generatedAt: new Date(now).toISOString(),
		website: { id: websiteId, domain, business },
		access: { allowedOrigins: [`https://${domain}`], testingOrigins: [...TESTING_HOSTS], serverTokens: SERVER_TOKENS_NOTE },
		products,
	};
};

/**
 * The copy a share link shows: without values every setting's value is left out, without install the browser token
 * and the snippet; `share` says so.
 * @param {Blueprint} sheet
 * @param {{ values: boolean, install: boolean, expiresAt: string }} link
 * @returns {Blueprint}
 */
export const sharedCopy = (sheet, { values, install, expiresAt }) => ({
	...sheet,
	products: sheet.products.map((product) => {
		if (!product.reachable) return product;
		/** @param {import('@ss/contracts').BlueprintSetting[]} settings */
		const strip = (settings) =>
			values ? settings : settings.map(({ key, title, default: isDefault }) => ({ key, title, default: isDefault }));
		const { scriptUrl, installed, lastSeenAt } = product.install;
		return {
			...product,
			install: install ? product.install : { scriptUrl, installed, lastSeenAt },
			features: product.features.map((feature) => ({ ...feature, settings: strip(feature.settings) })),
			shared: product.shared.map((group) => ({ ...group, settings: strip(group.settings) })),
		};
	}),
	share: { expiresAt, values, install },
});

/**
 * The body of Create share link: `{ days?: 1–30 (default 7), values?: boolean (default true), install?: boolean
 * (default true) }`.
 * @param {unknown} body
 * @returns {{ ok: true, value: { days: number, values: boolean, install: boolean } } |
 *   { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const parseShareLink = (body) => {
	const input =
		typeof body === 'object' && body !== null && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : null;
	if (input === null) return { ok: false, errors: [{ path: '', message: 'body must be a JSON object' }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = Object.keys(input)
		.filter((key) => !['days', 'values', 'install'].includes(key))
		.map((key) => ({ path: `/${key}`, message: 'unknown property' }));
	const days = input.days ?? SHARE_DAYS_DEFAULT;
	if (!Number.isInteger(days) || /** @type {number} */ (days) < 1 || /** @type {number} */ (days) > SHARE_DAYS_MAX)
		errors.push({ path: '/days', message: `must be a whole number of days from 1 to ${SHARE_DAYS_MAX}` });
	for (const key of /** @type {const} */ (['values', 'install']))
		if (input[key] !== undefined && typeof input[key] !== 'boolean')
			errors.push({ path: `/${key}`, message: 'must be true or false' });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { days: /** @type {number} */ (days), values: input.values !== false, install: input.install !== false },
	};
};

/**
 * Why a product's answer is no part of the sheet (null when it is a 200).
 * @param {number} status
 * @returns {Unreachable | null}
 */
export const reasonOfStatus = (status) => {
	if (status === 200) return null;
	if (status >= 500) return 'unreachable';
	return 'refused';
};
