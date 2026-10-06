/**
 * Website-key scope vocabulary (pure; F.16). A key may only carry scopes from this catalogue:
 *
 * | scope              | meaning                                                                                  |
 * | ------------------ | ---------------------------------------------------------------------------------------- |
 * | `elements.read`    | read element views and resources (the Loader, the element stub, product `GET` routes)    |
 * | `events.write`     | send events to the Event Hub (`POST /v1/events`)                                         |
 * | `<product>.read`   | a product's own read routes (one pair per listed service product, `<product>` = its slug) |
 * | `<product>.write`  | a product's own write routes                                                             |
 * | `<group>.*`        | every scope of a group above (`events.*`, `<product>.*`); matched as a prefix by products |
 *
 * An empty list means the default {@link DEFAULT_SCOPES} (what the Loader's own key carries).
 * @module
 */

/** Scopes of a key issued without any. */
export const DEFAULT_SCOPES = Object.freeze(['elements.read', 'events.write']);

/**
 * @typedef {object} ScopeEntry
 * @property {string} scope
 * @property {string} group `platform` or a product slug
 * @property {string} label
 * @property {string} description
 * @property {string} [product] product name (product scopes)
 */

/** @type {ReadonlyArray<ScopeEntry>} */
export const CORE_SCOPES = Object.freeze([
	Object.freeze({
		scope: 'elements.read',
		group: 'platform',
		label: 'Read elements',
		description: 'Element views and read-only product resources (what the website’s own bundle uses).',
	}),
	Object.freeze({
		scope: 'events.write',
		group: 'platform',
		label: 'Send events',
		description: 'Send events from the website or its server to the Event Hub.',
	}),
]);

/**
 * The catalogue for a set of service products.
 * @param {ReadonlyArray<{ slug: string, name?: string }>} products
 * @returns {ScopeEntry[]}
 */
export const scopeCatalogue = (products) => {
	const seen = new Set(CORE_SCOPES.map((entry) => entry.scope.split('.')[0]));
	/** @type {ScopeEntry[]} */
	const out = [...CORE_SCOPES];
	for (const product of [...products].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
		if (typeof product.slug !== 'string' || seen.has(product.slug)) continue;
		seen.add(product.slug);
		const name = product.name ?? product.slug;
		out.push(
			{
				scope: `${product.slug}.read`,
				group: product.slug,
				product: name,
				label: 'Read',
				description: `${name}: read routes.`,
			},
			{
				scope: `${product.slug}.write`,
				group: product.slug,
				product: name,
				label: 'Write',
				description: `${name}: write routes.`,
			},
		);
	}
	return out;
};

/**
 * Check requested scopes against a catalogue: exact names, or `<group>.*` of a known group. Empty → defaults.
 * @param {ReadonlyArray<string>} requested
 * @param {ReadonlyArray<ScopeEntry>} catalogue
 * @returns {{ ok: true, value: string[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkScopes = (requested, catalogue) => {
	if (requested.length === 0) return { ok: true, value: [...DEFAULT_SCOPES] };
	const names = new Set(catalogue.map((entry) => entry.scope));
	const groups = new Set(catalogue.map((entry) => entry.scope.slice(0, entry.scope.lastIndexOf('.'))));
	const errors = requested.flatMap((scope, i) =>
		names.has(scope) || (scope.endsWith('.*') && groups.has(scope.slice(0, -2)))
			? []
			: [{ path: `/scopes/${i}`, message: `${scope} is not a website-key scope` }],
	);
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: [...requested] };
};
