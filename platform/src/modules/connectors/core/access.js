/**
 * Resolve authorisation (pure): may product `appId` obtain the `kind` resource of a website? Only when it has an
 * active subscription on that website and its accepted manifest requires the kind (top level or in an element).
 * @module
 */

/** Subscription statuses that keep resources resolvable. */
export const RESOLVABLE_SUBSCRIPTION = new Set(['active']);

/**
 * Resource kinds a manifest requires (top-level `requires.resources` and every element's).
 * @param {unknown} manifest
 * @returns {Set<string>}
 */
export const requiredKinds = (manifest) => {
	const m = /** @type {any} */ (manifest) ?? {};
	/** @type {Set<string>} */
	const kinds = new Set();
	const add = (/** @type {any} */ requires) => {
		for (const kind of Array.isArray(requires?.resources) ? requires.resources : [])
			if (typeof kind === 'string') kinds.add(kind);
	};
	add(m.requires);
	for (const element of Array.isArray(m.elements) ? m.elements : []) add(element?.requires);
	return kinds;
};

/**
 * @param {{ appId: string, websiteId: string, kind: string, subscriptions: unknown, manifest: unknown }} input
 * @returns {{ ok: true, subscriptionId: string } | { ok: false, reason: 'no_subscription' | 'not_required' }}
 */
export const decideResolve = ({ appId, websiteId, kind, subscriptions, manifest }) => {
	const list = Array.isArray(subscriptions) ? subscriptions : [];
	const active = list.find(
		(/** @type {any} */ s) =>
			s?.appId === appId && (s.websiteId === undefined || s.websiteId === websiteId) && RESOLVABLE_SUBSCRIPTION.has(s.status),
	);
	if (!active) return { ok: false, reason: 'no_subscription' };
	if (!requiredKinds(manifest).has(kind)) return { ok: false, reason: 'not_required' };
	return { ok: true, subscriptionId: String(active.subscriptionId) };
};
