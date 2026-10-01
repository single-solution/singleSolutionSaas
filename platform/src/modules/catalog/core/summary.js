/**
 * Catalog read models derived from an accepted manifest (pure). All prices are integer millicredits (PLAN F.1);
 * nothing here is stored — listings are always computed from the current accepted manifest.
 * @module
 */

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').ManifestElement} ManifestElement */

/**
 * @param {ManifestElement} element
 */
const elementEntry = (element) => ({
	key: element.key,
	name: element.name,
	...(element.description ? { description: element.description } : {}),
	modes: [...element.modes],
	dependsOn: [...(element.dependsOn ?? [])],
	requires: [...(element.requires?.resources ?? [])],
	price: {
		hourlyMillicredits: element.price.hourly,
		metered: (element.price.metered ?? []).map((m) => ({
			unit: m.unit,
			perUnitMillicredits: m.perUnit,
			per: m.per ?? 1,
			included: { ...(m.included ?? {}) },
		})),
	},
	configurable: Object.keys(element.features?.properties ?? {}).length > 0,
});

/**
 * Plan view: included elements, add-ons and the hourly price of the included set (`base` = sum of hourly prices).
 * @param {Manifest} manifest
 */
export const planEntries = (manifest) => {
	const hourly = new Map(manifest.elements.map((e) => [e.key, e.price.hourly]));
	return (manifest.plans ?? []).map((plan) => ({
		code: plan.code,
		...(plan.name ? { name: plan.name } : {}),
		...(plan.description ? { description: plan.description } : {}),
		elements: [...plan.elements],
		addons: [...(plan.addons ?? [])],
		includedHourlyMillicredits: plan.elements.reduce((sum, key) => sum + (hourly.get(key) ?? 0), 0),
		maxHourlyMillicredits: [...plan.elements, ...(plan.addons ?? [])].reduce((sum, key) => sum + (hourly.get(key) ?? 0), 0),
	}));
};

/**
 * Price summary: cheapest and full hourly cost, whether usage is metered, trial hours.
 * @param {Manifest} manifest
 */
export const priceSummary = (manifest) => {
	const hourly = manifest.elements.map((e) => e.price.hourly);
	const plans = planEntries(manifest);
	const all = hourly.reduce((a, b) => a + b, 0);
	const fromHourly = plans.length > 0 ? Math.min(...plans.map((p) => p.includedHourlyMillicredits)) : Math.min(...hourly);
	return {
		fromHourlyMillicredits: fromHourly,
		allElementsHourlyMillicredits: all,
		metered: manifest.elements.some((e) => (e.price.metered ?? []).length > 0),
		free: all === 0 && !manifest.elements.some((e) => (e.price.metered ?? []).some((m) => m.perUnit > 0)),
		trialHours: manifest.trialHours ?? 0,
		priceBook: { version: manifest.priceBook.version, effectiveFrom: manifest.priceBook.effectiveFrom },
	};
};

/**
 * Catalog entry for consoles and the public marketplace.
 * @param {{ appId: string, slug: string, kind: string, status: string, sunsetAt?: Date | null, currentVersion: number }} app
 * @param {Manifest} manifest
 * @param {{ detail?: boolean }} [options] `detail` adds the feature schemas (for configuration forms)
 */
export const catalogEntry = (app, manifest, { detail = false } = {}) => ({
	appId: app.appId,
	slug: app.slug,
	kind: app.kind,
	status: app.status,
	sunsetAt: app.sunsetAt instanceof Date ? app.sunsetAt.toISOString() : null,
	name: manifest.product.name,
	category: manifest.product.category,
	...(manifest.product.description ? { description: manifest.product.description } : {}),
	version: manifest.product.version,
	manifestVersion: app.currentVersion,
	capabilities: {
		adminLaunch: manifest.capabilities?.adminLaunch === true,
		sandbox: manifest.capabilities?.sandbox === true,
		// F.16: the product may ask to become a website's identity issuer (merchant approval required)
		identityIssuer: /** @type {Record<string, unknown> | undefined} */ (manifest.capabilities)?.identityIssuer === true,
	},
	requires: [...(manifest.requires?.resources ?? [])],
	elements: manifest.elements.map((element) =>
		detail ? { ...elementEntry(element), features: element.features ?? null } : elementEntry(element),
	),
	plans: planEntries(manifest),
	price: priceSummary(manifest),
});
