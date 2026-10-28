/**
 * Peers demoted into parent capability settings (FEATURE-AUDIT / PLAN E).
 * Runtime `has` / expanded `on` treat these as on when the parent is on and the enable flag is true.
 * Route `feature` keys must name the parent (manifest no longer lists demoted peers).
 * @module
 */

/**
 * @typedef {{ parent: string, enable: string | null }} DemoteMeta
 * @type {Readonly<Record<string, DemoteMeta>>}
 */
export const DEMOTE = Object.freeze({
	store_details: { parent: 'catalog', enable: null },
	variants: { parent: 'catalog', enable: 'enableVariants' },
	size_charts: { parent: 'catalog', enable: 'enableSizeCharts' },
	multi_location: { parent: 'catalog', enable: 'enableMultiLocation' },
	grades_serials: { parent: 'catalog', enable: 'enableGradesSerials' },
	measured_sales: { parent: 'catalog', enable: 'enableMeasuredSales' },
	wishlist: { parent: 'catalog', enable: 'enableWishlist' },
	compare: { parent: 'catalog', enable: 'enableCompare' },
	alerts: { parent: 'catalog', enable: 'enableAlerts' },
	csv: { parent: 'catalog', enable: 'enableCsv' },
	bulk_actions: { parent: 'catalog', enable: 'enableBulkActions' },
	events: { parent: 'catalog', enable: 'enableEvents' },
	staff_alerts: { parent: 'checkout', enable: 'enableStaffAlerts' },
	role_pricing: { parent: 'checkout', enable: 'enableRolePricing' },
	courier_apis: { parent: 'delivery_zones', enable: 'enableCourierApis' },
	landing_pages: { parent: 'seo', enable: 'enableLandingPages' },
	llms_txt: { parent: 'seo', enable: 'enableLlmsTxt' },
});

/** Schema defaults for enable flags (match catalog / folded parent settings). */
export const ENABLE_DEFAULTS = Object.freeze({
	enableVariants: true,
	enableSizeCharts: false,
	enableMultiLocation: false,
	enableGradesSerials: false,
	enableMeasuredSales: false,
	enableWishlist: false,
	enableCompare: false,
	enableAlerts: false,
	enableCsv: true,
	enableBulkActions: true,
	enableEvents: false,
	enableStaffAlerts: false,
	enableRolePricing: false,
	enableCourierApis: false,
	enableLandingPages: false,
	enableLlmsTxt: false,
});

/** Setting keys still read via `values('<demoted>')` — sliced from the parent bag. */
export const VALUES_KEYS = Object.freeze({
	size_charts: Object.freeze(['defaultChartId']),
	csv: Object.freeze(['delimiter']),
	alerts: Object.freeze(['channels', 'guests', 'targetPrice', 'stopUrl']),
	staff_alerts: Object.freeze(['events', 'staffPermission', 'adminUrl', 'includePhone']),
	courier_apis: Object.freeze(['courier']),
	landing_pages: Object.freeze([
		'landingUrl',
		'auto',
		'autoFacet',
		'autoCopy',
		'autoTitle',
		'autoDescription',
		'attributeUrl',
		'attributeTitle',
		'attributeDescription',
		'gradeUrl',
		'gradeTitle',
		'gradeDescription',
	]),
	llms_txt: Object.freeze(['description', 'policies', 'full', 'custom']),
});

/** Parents that hold demoted settings. */
export const DEMOTE_PARENTS = Object.freeze(['catalog', 'checkout', 'delivery_zones', 'seo']);

/**
 * @param {Record<string, unknown> | null | undefined} bag
 * @param {string} enable
 */
const flagOn = (bag, enable) => {
	const raw = bag?.[enable];
	const fallback = ENABLE_DEFAULTS[/** @type {keyof typeof ENABLE_DEFAULTS} */ (enable)];
	return (raw === undefined ? fallback : raw) === true;
};

/**
 * Whether a (possibly demoted) feature is on.
 * @param {readonly string[]} featuresOn
 * @param {Record<string, Record<string, unknown> | null | undefined>} parentSettings
 * @param {string} key
 */
export const featureOn = (featuresOn, parentSettings, key) => {
	if (featuresOn.includes(key)) return true;
	const meta = DEMOTE[key];
	if (!meta) return false;
	if (key === 'store_details') return featuresOn.includes('catalog') || featuresOn.includes('checkout');
	if (!featuresOn.includes(meta.parent)) return false;
	if (meta.enable === null) return true;
	return flagOn(parentSettings[meta.parent], meta.enable);
};

/**
 * Base switches plus demoted peers whose enable flags are on.
 * @param {readonly string[]} baseOn
 * @param {Record<string, Record<string, unknown> | null | undefined>} parentSettings
 */
export const expandFeaturesOn = (baseOn, parentSettings) => {
	const out = [...baseOn];
	for (const key of Object.keys(DEMOTE)) {
		if (out.includes(key)) continue;
		if (featureOn(baseOn, parentSettings, key)) out.push(key);
	}
	return out;
};

/**
 * Pick demoted values from a parent settings bag (with schema-ish defaults left to the caller).
 * @param {Record<string, unknown>} parent
 * @param {string} demoted
 */
export const sliceValues = (parent, demoted) => {
	const keys = VALUES_KEYS[/** @type {keyof typeof VALUES_KEYS} */ (demoted)];
	if (!keys) return {};
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const key of keys) if (Object.hasOwn(parent, key)) out[key] = parent[key];
	return out;
};

/**
 * Parent feature for a demoted route/list key (identity if not demoted).
 * @param {string} key
 */
export const parentOf = (key) => DEMOTE[key]?.parent ?? key;
