/**
 * Pure manifest diff: what changes between the accepted manifest and a candidate, and which changes are breaking for
 * existing subscribers. Staff review shows this before approving a version (PLAN Part E §13 "breaking manifest
 * changes flagged").
 *
 * Breaking (`breaking[].code`):
 * - `element_removed`, `feature_removed`, `plan_removed`, `plan_element_removed` (included element or add-on dropped)
 * - `max_lowered` (`maximum`, `exclusiveMaximum`, `maxLength`, `maxItems` or an `x-plan` max lowered or newly imposed),
 *   `min_raised` (`minimum`, `exclusiveMinimum`, `minLength`, `minItems` raised or newly imposed)
 * - `feature_type_changed`, `enum_value_removed`, `mode_removed`
 * - `price_increase` (hourly price up, metered rate up, included quota lowered, new metered unit)
 * @module
 */
import { jsonEqual } from '@ss/contracts';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').ManifestElement} ManifestElement */
/** @typedef {import('@ss/contracts').ManifestPlan} ManifestPlan */
/** @typedef {{ code: string, path: string, message: string }} BreakingChange */
/**
 * @typedef {object} PriceChange
 * @property {string} element
 * @property {string} field `hourly`, `metered:<unit>` or `included:<unit>:<plan>`
 * @property {unknown} from
 * @property {unknown} to
 * @property {'increase' | 'decrease' | 'added' | 'removed'} direction
 */
/** @typedef {{ element: string, feature: string, change: 'added' | 'removed' | 'changed', fields: string[] }} FeatureChange */
/**
 * @typedef {object} ManifestDiff
 * @property {{ from: string | null, to: string }} version product semver
 * @property {{ added: string[], removed: string[], changed: Array<{ key: string, fields: string[] }> }} elements
 * @property {PriceChange[]} prices
 * @property {{ added: string[], removed: string[], changed: Array<{ code: string, elementsAdded: string[], elementsRemoved: string[], addonsAdded: string[], addonsRemoved: string[] }> }} plans
 * @property {FeatureChange[]} features
 * @property {{ priceBook: boolean, endpoints: boolean, capabilities: boolean, scopesAdded: string[], scopesRemoved: string[], eventsChanged: boolean, requiresChanged: boolean, trialHours: boolean }} other
 * @property {BreakingChange[]} breaking
 * @property {boolean} isBreaking
 * @property {boolean} changed any difference at all
 */

const UPPER_BOUNDS = Object.freeze(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems']);
const LOWER_BOUNDS = Object.freeze(['minimum', 'exclusiveMinimum', 'minLength', 'minItems']);

/**
 * @template T
 * @param {ReadonlyArray<T>} items
 * @param {(item: T) => string} keyOf
 * @returns {Map<string, T>}
 */
const byKey = (items, keyOf) => new Map(items.map((item) => [keyOf(item), item]));

/**
 * @param {ReadonlyArray<string>} a
 * @param {ReadonlyArray<string>} b
 * @returns {string[]} items of `a` that are not in `b`, sorted
 */
const minus = (a, b) => {
	const set = new Set(b);
	return [...new Set(a)].filter((x) => !set.has(x)).sort();
};

/**
 * Compare two metered rates `perUnit / per` exactly. Positive when `b` is more expensive than `a`.
 * @param {{ perUnit: number, per?: number }} a
 * @param {{ perUnit: number, per?: number }} b
 * @returns {number}
 */
export const compareRates = (a, b) => {
	const left = BigInt(b.perUnit) * BigInt(a.per ?? 1);
	const right = BigInt(a.perUnit) * BigInt(b.per ?? 1);
	return left === right ? 0 : left > right ? 1 : -1;
};

/**
 * Numeric value of an `x-plan` max for comparison (`true`/`false` for flags become 1/0).
 * @param {unknown} value
 * @returns {number | null}
 */
const maxValue = (value) => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return null;
};

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
const obj = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {any} */ (value) : {});

/**
 * Walk two feature nodes in parallel, collecting changes and breaking flags.
 * @param {{ element: string, path: string[], before: Record<string, any> | undefined, after: Record<string, any> | undefined,
 *   features: FeatureChange[], breaking: BreakingChange[] }} input
 */
const diffNode = ({ element, path, before, after, features, breaking }) => {
	const feature = path.join('.');
	const where = `elements.${element}.features.${feature}`;
	if (before && !after) {
		features.push({ element, feature, change: 'removed', fields: [] });
		breaking.push({ code: 'feature_removed', path: where, message: `feature ${element}.${feature} was removed` });
		return;
	}
	if (!before && after) {
		features.push({ element, feature, change: 'added', fields: [] });
		return;
	}
	if (!before || !after) return;
	/** @type {string[]} */
	const fields = [];
	const own = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => key !== 'properties' && key !== 'items'));
	for (const key of [...own].sort()) if (!jsonEqual(before[key], after[key])) fields.push(key);

	if (before.type !== after.type) {
		breaking.push({
			code: 'feature_type_changed',
			path: where,
			message: `feature ${element}.${feature} changed type from ${before.type} to ${after.type}`,
		});
	}
	for (const bound of UPPER_BOUNDS) {
		const from = before[bound];
		const to = after[bound];
		if (typeof to === 'number' && (typeof from !== 'number' || to < from))
			breaking.push({
				code: 'max_lowered',
				path: `${where}.${bound}`,
				message: `${bound} lowered from ${from ?? 'none'} to ${to}`,
			});
	}
	for (const bound of LOWER_BOUNDS) {
		const from = before[bound];
		const to = after[bound];
		if (typeof to === 'number' && (typeof from !== 'number' || to > from))
			breaking.push({
				code: 'min_raised',
				path: `${where}.${bound}`,
				message: `${bound} raised from ${from ?? 'none'} to ${to}`,
			});
	}
	const enumFrom = Array.isArray(before.enum) ? before.enum : null;
	const enumTo = Array.isArray(after.enum) ? after.enum : null;
	if (enumTo) {
		const removed = enumFrom ? enumFrom.filter((v) => !enumTo.some((w) => jsonEqual(v, w))) : ['(any value)'];
		if (removed.length > 0)
			breaking.push({
				code: 'enum_value_removed',
				path: `${where}.enum`,
				message: `allowed values removed: ${removed.map((v) => JSON.stringify(v)).join(', ')}`,
			});
	}
	const plansFrom = obj(before['x-plan']);
	const plansTo = obj(after['x-plan']);
	for (const code of Object.keys(plansTo).sort()) {
		const from = maxValue(obj(plansFrom[code]).max);
		const to = maxValue(obj(plansTo[code]).max);
		if (to !== null && (from === null || to < from))
			breaking.push({
				code: 'max_lowered',
				path: `${where}.x-plan.${code}.max`,
				message: `plan ${code} max lowered from ${from ?? 'none'} to ${to}`,
			});
	}
	// array item schemas: bounds and enums inside `items` bind every value
	if (before.items && after.items)
		diffNode({ element, path: [...path, 'items'], before: before.items, after: after.items, features, breaking });
	else if (!jsonEqual(before.items, after.items)) fields.push('items');
	if (fields.length > 0) features.push({ element, feature, change: 'changed', fields: fields.sort() });
	const childrenFrom = obj(before.properties);
	const childrenTo = obj(after.properties);
	for (const name of [...new Set([...Object.keys(childrenFrom), ...Object.keys(childrenTo)])].sort()) {
		diffNode({ element, path: [...path, name], before: childrenFrom[name], after: childrenTo[name], features, breaking });
	}
};

/**
 * @param {ManifestElement} before
 * @param {ManifestElement} after
 * @param {PriceChange[]} prices
 * @param {BreakingChange[]} breaking
 */
const diffPrices = (before, after, prices, breaking) => {
	const element = after.key;
	if (before.price.hourly !== after.price.hourly) {
		const up = after.price.hourly > before.price.hourly;
		prices.push({
			element,
			field: 'hourly',
			from: before.price.hourly,
			to: after.price.hourly,
			direction: up ? 'increase' : 'decrease',
		});
		if (up)
			breaking.push({
				code: 'price_increase',
				path: `elements.${element}.price.hourly`,
				message: `hourly price of ${element} rose from ${before.price.hourly} to ${after.price.hourly} millicredits`,
			});
	}
	const metFrom = byKey(before.price.metered ?? [], (m) => m.unit);
	const metTo = byKey(after.price.metered ?? [], (m) => m.unit);
	for (const [unit, from] of metFrom) {
		if (!metTo.has(unit)) prices.push({ element, field: `metered:${unit}`, from, to: null, direction: 'removed' });
	}
	for (const [unit, to] of metTo) {
		const from = metFrom.get(unit);
		const path = `elements.${element}.price.metered.${unit}`;
		if (!from) {
			prices.push({ element, field: `metered:${unit}`, from: null, to, direction: 'added' });
			breaking.push({ code: 'price_increase', path, message: `new metered charge ${unit} on ${element}` });
			continue;
		}
		const rate = compareRates(from, to);
		if (rate !== 0) {
			prices.push({
				element,
				field: `metered:${unit}`,
				from: { perUnit: from.perUnit, per: from.per ?? 1 },
				to: { perUnit: to.perUnit, per: to.per ?? 1 },
				direction: rate > 0 ? 'increase' : 'decrease',
			});
			if (rate > 0) breaking.push({ code: 'price_increase', path, message: `metered rate of ${unit} on ${element} rose` });
		}
		const incFrom = from.included ?? {};
		const incTo = to.included ?? {};
		for (const plan of [...new Set([...Object.keys(incFrom), ...Object.keys(incTo)])].sort()) {
			const a = incFrom[plan] ?? 0;
			const b = incTo[plan] ?? 0;
			if (a === b) continue;
			prices.push({ element, field: `included:${unit}:${plan}`, from: a, to: b, direction: b < a ? 'increase' : 'decrease' });
			if (b < a)
				breaking.push({
					code: 'price_increase',
					path: `${path}.included.${plan}`,
					message: `included ${unit} on plan ${plan} lowered from ${a} to ${b}`,
				});
		}
	}
};

/**
 * Diff two manifests. `before` may be `null` (first version: everything is "added", nothing is breaking).
 * @param {Manifest | null} before
 * @param {Manifest} after
 * @returns {ManifestDiff}
 */
export const diffManifests = (before, after) => {
	/** @type {BreakingChange[]} */
	const breaking = [];
	/** @type {PriceChange[]} */
	const prices = [];
	/** @type {FeatureChange[]} */
	const features = [];
	const elFrom = byKey(before?.elements ?? [], (e) => e.key);
	const elTo = byKey(after.elements, (e) => e.key);
	const added = [...elTo.keys()].filter((k) => !elFrom.has(k)).sort();
	const removed = [...elFrom.keys()].filter((k) => !elTo.has(k)).sort();
	for (const key of removed)
		breaking.push({ code: 'element_removed', path: `elements.${key}`, message: `element ${key} was removed` });
	/** @type {Array<{ key: string, fields: string[] }>} */
	const changed = [];
	for (const [key, next] of elTo) {
		const prev = elFrom.get(key);
		if (!prev) continue;
		const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
		const fields = [...keys]
			.filter((field) => !jsonEqual(/** @type {any} */ (prev)[field], /** @type {any} */ (next)[field]))
			.sort();
		if (fields.length > 0) changed.push({ key, fields });
		for (const mode of minus(prev.modes, next.modes))
			breaking.push({ code: 'mode_removed', path: `elements.${key}.modes`, message: `mode ${mode} of ${key} was removed` });
		diffPrices(prev, next, prices, breaking);
		const fFrom = obj(prev.features?.properties);
		const fTo = obj(next.features?.properties);
		for (const name of [...new Set([...Object.keys(fFrom), ...Object.keys(fTo)])].sort()) {
			diffNode({ element: key, path: [name], before: fFrom[name], after: fTo[name], features, breaking });
		}
	}

	const plFrom = byKey(before?.plans ?? [], (p) => p.code);
	const plTo = byKey(after.plans ?? [], (p) => p.code);
	const plansAdded = [...plTo.keys()].filter((c) => !plFrom.has(c)).sort();
	const plansRemoved = [...plFrom.keys()].filter((c) => !plTo.has(c)).sort();
	for (const code of plansRemoved)
		breaking.push({ code: 'plan_removed', path: `plans.${code}`, message: `plan ${code} was removed` });
	/** @type {ManifestDiff['plans']['changed']} */
	const plansChanged = [];
	for (const [code, next] of plTo) {
		const prev = plFrom.get(code);
		if (!prev) continue;
		const entry = {
			code,
			elementsAdded: minus(next.elements, prev.elements),
			elementsRemoved: minus(prev.elements, next.elements),
			addonsAdded: minus(next.addons ?? [], prev.addons ?? []),
			addonsRemoved: minus(prev.addons ?? [], next.addons ?? []),
		};
		// an element moved from add-on to included (or back) is not removed from the plan
		const stillAllowed = new Set([...next.elements, ...(next.addons ?? [])]);
		for (const key of [...entry.elementsRemoved, ...entry.addonsRemoved]) {
			if (!stillAllowed.has(key))
				breaking.push({
					code: 'plan_element_removed',
					path: `plans.${code}`,
					message: `plan ${code} no longer offers ${key}`,
				});
		}
		const otherFields = !jsonEqual(prev.name, next.name) || !jsonEqual(prev.description, next.description);
		if (
			entry.elementsAdded.length + entry.elementsRemoved.length + entry.addonsAdded.length + entry.addonsRemoved.length > 0 ||
			otherFields
		)
			plansChanged.push(entry);
	}

	const scopesFrom = before?.scopes ?? [];
	const scopesTo = after.scopes ?? [];
	const other = {
		priceBook: !jsonEqual(before?.priceBook, after.priceBook),
		endpoints: !jsonEqual(before?.endpoints, after.endpoints),
		capabilities: !jsonEqual(before?.capabilities, after.capabilities),
		scopesAdded: minus(scopesTo, scopesFrom),
		scopesRemoved: minus(scopesFrom, scopesTo),
		eventsChanged: !jsonEqual(before?.events, after.events),
		requiresChanged: !jsonEqual(before?.requires, after.requires),
		trialHours: !jsonEqual(before?.trialHours, after.trialHours),
	};
	const effectiveBreaking = before === null ? [] : breaking;
	return {
		version: { from: before?.product.version ?? null, to: after.product.version },
		elements: { added, removed, changed },
		prices,
		plans: { added: plansAdded, removed: plansRemoved, changed: plansChanged },
		features,
		other,
		breaking: effectiveBreaking,
		isBreaking: effectiveBreaking.length > 0,
		changed: !jsonEqual(before, after),
	};
};
