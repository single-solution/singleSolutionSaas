/**
 * Resolve authorisation (pure): may product `appId` obtain the `kind` resource of a website? Only when it has an
 * active subscription on that website and the kind is needed (F.16): a product-level `requires.resources` kind
 * always, an element-level kind only while a requiring element is on (commerce `resourceNeeds`; without them, any
 * kind the accepted manifest requires).
 * @module
 */

/** Subscription statuses that keep resources resolvable. */
export const RESOLVABLE_SUBSCRIPTION = new Set(['active']);

/**
 * Resource kinds a manifest requires (top-level `requires.resources` and every element's, optional ones included:
 * an element uses an optional kind when it is connected, F.18).
 * @param {unknown} manifest
 * @returns {Set<string>}
 */
export const requiredKinds = (manifest) => {
	const m = /** @type {any} */ (manifest) ?? {};
	/** @type {Set<string>} */
	const kinds = new Set();
	const add = (/** @type {any} */ requires) => {
		for (const list of [requires?.resources, requires?.optionalResources])
			for (const kind of Array.isArray(list) ? list : []) if (typeof kind === 'string') kinds.add(kind);
	};
	add(m.requires);
	for (const element of Array.isArray(m.elements) ? m.elements : []) add(element?.requires);
	return kinds;
};

/**
 * @param {{ appId: string, websiteId: string, kind: string, subscriptions: unknown, manifest: unknown,
 *   needs?: ReadonlyArray<{ appId: string, kind: string, neededNow: boolean }> | null }} input
 * @returns {{ ok: true, subscriptionId: string } | { ok: false, reason: 'no_subscription' | 'not_required' | 'element_off' }}
 */
export const decideResolve = ({ appId, websiteId, kind, subscriptions, manifest, needs = null }) => {
	const list = Array.isArray(subscriptions) ? subscriptions : [];
	const active = list.find(
		(/** @type {any} */ s) =>
			s?.appId === appId && (s.websiteId === undefined || s.websiteId === websiteId) && RESOLVABLE_SUBSCRIPTION.has(s.status),
	);
	if (!active) return { ok: false, reason: 'no_subscription' };
	if (!requiredKinds(manifest).has(kind)) return { ok: false, reason: 'not_required' };
	if (Array.isArray(needs) && !needs.some((n) => n.appId === appId && n.kind === kind && n.neededNow))
		return { ok: false, reason: 'element_off' };
	return { ok: true, subscriptionId: String(active.subscriptionId) };
};
