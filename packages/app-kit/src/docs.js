/**
 * The toolkit of a product's public `/docs` page (PLAN 0.4.10): the page itself (head and style, title, intro, the
 * localhost note, the kit's sections for the merchant's server, business.json and the API reference with its route
 * table), one section per feature (its words, what it needs, what the website builds, its widgets and its routes) and
 * the small HTML pieces a product's own sections are written with. A product's `server/docs.js` keeps only its own
 * sections. Plain HTML: every value is escaped (pieces documented as HTML are taken as they are).
 * @module
 */
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import { escapeHtml } from '@ss/contracts/text';
import { isObject } from '@ss/contracts/util';
import { apiAnchor, renderApiReference } from './api-reference.js';
import { KIT_GUIDE } from './guide.js';

/**
 * An operation of `openapi.json` as the docs read it.
 * @typedef {{ 'x-ss-auth'?: string, 'x-ss-feature'?: string | string[], 'x-ss-permission'?: string, summary?: string }} DocsOperation
 */
/** One documented operation: `[METHOD, path, operation]`. @typedef {readonly [string, string, DocsOperation]} DocsRow */
/**
 * The product's `docs/guide.json` texts the kit renders (plain text).
 * @typedef {object} DocsGuide
 * @property {string} title the page title
 * @property {string} intro the first paragraph
 * @property {string} localhost the local testing note
 * @property {string} business what the business.json section says
 * @property {string} api what the API reference section says
 * @property {string} [kit] the product's own note after the kit's sections (its lists, counts …)
 * @property {Record<string, string[]>} [features] more paragraphs per feature key
 * @property {Record<string, string>} [build] what the merchant's website builds per feature key
 */
/**
 * The manifest parts the feature sections read.
 * @typedef {object} DocsManifest
 * @property {string} id the product id (widgets are placed with `data-ss-<id>="<widget key>"`)
 * @property {ReadonlyArray<{ key: string, name: string, description: string, dependsOn?: ReadonlyArray<string> }>} features
 * @property {ReadonlyArray<{ key: string, kind: string, feature: string | ReadonlyArray<string> }>} widgets
 */

/** The page style: readable on any screen, the system colors (light and dark). */
const STYLE = `body { font: 16px/1.6 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px; color: CanvasText; background: Canvas; }
pre { overflow-x: auto; padding: 12px; border: 1px solid GrayText; border-radius: 8px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid GrayText; }
td code { overflow-wrap: anywhere; }
.ss-api-op { margin-top: 32px; } .ss-api-op h3 code, .ss-api-schema h4 { overflow-wrap: anywhere; }`;

/** The API reference of each `openapi.json`, rendered once (it is the same for every request). @type {WeakMap<object, string>} */
const references = new WeakMap();

/**
 * Code as a block (`<pre><code>`).
 * @param {string} code plain text
 * @returns {string}
 */
export const docsBlock = (code) => `<pre><code>${escapeHtml(code)}</code></pre>`;

/**
 * A paragraph.
 * @param {string} text plain text
 * @returns {string}
 */
export const docsParagraph = (text) => `<p>${escapeHtml(text)}</p>`;

/**
 * A bulleted list, or nothing when there is no item.
 * @param {ReadonlyArray<string>} items HTML, already escaped
 * @returns {string}
 */
export const docsList = (items) => (items.length > 0 ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '');

/**
 * Every operation of an OpenAPI document, in its order: `[METHOD, path, operation]`.
 * @param {unknown} openapi the product's `openapi.json` (or `{ paths }`)
 * @returns {DocsRow[]}
 */
export const docsOperations = (openapi) => {
	const paths = isObject(openapi) && isObject(openapi.paths) ? openapi.paths : {};
	return Object.entries(paths).flatMap(([path, methods]) =>
		Object.entries(isObject(methods) ? methods : {})
			.filter(([, operation]) => isObject(operation))
			.map(([method, operation]) => /** @type {DocsRow} */ ([method.toUpperCase(), path, operation])),
	);
};

/**
 * The features an operation belongs to (`x-ss-feature`: one key, or a list when any of them is enough).
 * @param {DocsOperation} operation
 * @returns {string[]}
 */
export const operationFeatures = (operation) => [operation['x-ss-feature'] ?? []].flat();

/**
 * The route table (route linked to its place in the API reference, auth with the permission, feature), or nothing when
 * there is no route.
 * @param {ReadonlyArray<DocsRow>} rows
 * @returns {string}
 */
export const docsRouteTable = (rows) =>
	rows.length === 0
		? ''
		: `<table><thead><tr><th>Route</th><th>Auth</th><th>Feature</th></tr></thead><tbody>${rows
				.map(([method, path, operation]) => {
					const features = operationFeatures(operation);
					const auth = `${operation['x-ss-auth'] ?? ''}${operation['x-ss-permission'] ? ` (${operation['x-ss-permission']})` : ''}`;
					return `<tr><td><a href="#${escapeHtml(apiAnchor(method, path))}"><code>${escapeHtml(`${method} ${path}`)}</code></a>${
						operation.summary ? ` ${escapeHtml(operation.summary)}` : ''
					}</td><td>${escapeHtml(auth)}</td><td>${escapeHtml(features.length > 0 ? features.join(' or ') : 'always')}</td></tr>`;
				})
				.join('')}</tbody></table>`;

/**
 * One section per feature of the manifest (`#feature-<key>`, the Setup sheet links there): its name and key, its
 * description, the guide's paragraphs, what it needs, what the website builds, its widgets and its routes. A feature
 * with no widget or no route shows no empty list or table.
 * @param {{ manifest: DocsManifest, rows: ReadonlyArray<DocsRow>, guide?: Pick<DocsGuide, 'features' | 'build'> }} input
 *   `rows`: `docsOperations(openapi)`
 * @returns {string}
 */
export const docsFeatureSections = ({ manifest, rows, guide = {} }) => {
	const nameOf = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	const attribute = `data-ss-${manifest.id}`;
	return manifest.features
		.map((feature) => {
			const widgets = manifest.widgets.filter((widget) => [widget.feature].flat().includes(feature.key));
			const needs = (feature.dependsOn ?? []).map((key) => nameOf.get(key) ?? key);
			const build = guide.build?.[feature.key];
			return [
				`<section id="feature-${escapeHtml(feature.key)}"><h3>${escapeHtml(feature.name)} <code>${escapeHtml(feature.key)}</code></h3>`,
				docsParagraph(feature.description),
				...(guide.features?.[feature.key] ?? []).map(docsParagraph),
				needs.length > 0 ? docsParagraph(`Needs: ${needs.join(', ')}.`) : '',
				build ? `<p><strong>What your website builds.</strong> ${escapeHtml(build)}</p>` : '',
				docsList(
					widgets.map(
						(widget) => `${escapeHtml(widget.kind)} widget <code>${escapeHtml(`${attribute}="${widget.key}"`)}</code>`,
					),
				),
				docsRouteTable(rows.filter(([, , operation]) => operationFeatures(operation).includes(feature.key))),
				'</section>',
			].join('');
		})
		.join('\n');
};

/**
 * The whole `/docs` page around the product's own sections: head and style, the title, the intro and the localhost
 * note, then `body`, then the kit's sections for the merchant's server (`KIT_GUIDE`, then the guide's `kit` note),
 * business.json (`#business`) and the API reference (`#api`: the route table and every operation from `openapi.json`).
 * @param {{ guide: DocsGuide, openapi: unknown, body: string }} input `body`: the product's own sections (HTML, escaped
 *   by the product; `docsFeatureSections` among them)
 * @returns {string}
 */
export const renderDocsPage = ({ guide, openapi, body }) => {
	const document = isObject(openapi) ? openapi : {};
	let reference = references.get(document);
	if (reference === undefined) {
		reference = renderApiReference(document);
		references.set(document, reference);
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guide.title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>${escapeHtml(guide.title)}</h1>
${docsParagraph(guide.intro)}
<p><strong>Local testing.</strong> ${escapeHtml(guide.localhost)}</p>
${body}
${KIT_GUIDE.map((section) => `<h2 id="${escapeHtml(section.id)}">${escapeHtml(section.title)}</h2>\n${section.paragraphs.map(docsParagraph).join('\n')}`).join('\n')}
${guide.kit ? docsParagraph(guide.kit) : ''}
<h2 id="business">business.json</h2>
${docsParagraph(guide.business)}
${docsBlock(JSON.stringify(BUSINESS_JSON_TEMPLATE, null, 2))}
<h2 id="api">API reference</h2>
${docsParagraph(guide.api)}
${docsRouteTable(docsOperations(document))}
${reference}
</body>
</html>
`;
};
