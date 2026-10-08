/**
 * Feature switches and the price and feature reports (PLAN 0.4.2, 0.4.12 rows 2–3).
 *
 * - Switches per website `{ on, featuresVersion }` are saved only after the Portal accepted the feature report; a
 *   product added to a website starts with every feature off.
 * - A price report is sent when an Owner saves the Prices screen (version = accepted + 1, saved only after a 2xx, no
 *   retry), and on the first request after a deploy that changed the manifest's feature list (kept prices, new features
 *   0, missing ones dropped). Only that second kind is retried, on a later request (at most once a minute per instance),
 *   while the `pending` flag is set in the product database.
 * @module
 */
import { isKitError } from './util.js';
import { problem } from './http/results.js';
import { currentFeatures, featuresDiffer } from './connection.js';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./recent.js').Who} Who */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */

const RETRY_MS = 60_000;

/**
 * The problem to answer for a failed Portal call.
 * @param {unknown} error
 * @returns {ProblemResult}
 */
const portalProblem = (error) => {
	if (!isKitError(error, 'portal_refused'))
		return problem('portal_unreachable', 'The Portal cannot be reached. Nothing was changed.');
	const status = /** @type {number} */ (error.details?.status);
	const detail = `The Portal refused the change (${error.details?.problem || status}). Nothing was changed.`;
	if (status === 404) return problem('website_not_found', detail);
	if (status === 409) return problem('conflict', detail);
	if (status === 400 || status === 422) return problem('validation_failed', detail);
	return problem('upstream_error', detail);
};

/**
 * Features that are on although a feature they need is off, as `[feature, missing dependency]` pairs.
 * @param {Manifest} manifest
 * @param {string[]} on
 * @returns {Array<[string, string]>}
 */
const missingDependencies = (manifest, on) =>
	manifest.features.flatMap((feature) =>
		on.includes(feature.key)
			? feature.dependsOn.filter((dep) => !on.includes(dep)).map((dep) => /** @type {[string, string]} */ ([feature.key, dep]))
			: [],
	);

/**
 * @param {{ store: Store, manifest: Manifest, connection: ReturnType<typeof import('./connection.js').createConnection>,
 *   status: import('./status.js').StatusCache, recent: import('./recent.js').RecentChanges, now: () => number,
 *   logger: import('./logger.js').Logger }} options
 */
export const createReports = ({ store, manifest, connection, status, recent, now, logger }) => {
	const keys = manifest.features.map((feature) => feature.key);
	let synced = false;
	let triedAt = -Infinity;

	/** @param {string} websiteId @returns {Promise<{ on: string[], featuresVersion: number }>} */
	const switches = async (websiteId) => {
		const doc = await store.get('switches', websiteId);
		return doc
			? { on: doc.on.filter((/** @type {string} */ key) => keys.includes(key)), featuresVersion: doc.featuresVersion }
			: { on: [], featuresVersion: 0 };
	};

	/**
	 * @param {{ prices: Record<string, number>, actor: Who }} input millicredits per hour by feature key; keys left out
	 *   keep their price
	 * @returns {Promise<{ ok: true, version: number } | { ok: false, problem: ProblemResult }>}
	 */
	const reportPrices = async ({ prices, actor }) => {
		const unknown = Object.keys(prices ?? {}).filter((key) => !keys.includes(key));
		const invalid = Object.entries(prices ?? {}).filter(([, value]) => !Number.isSafeInteger(value) || value < 0);
		if (unknown.length > 0 || invalid.length > 0)
			return {
				ok: false,
				problem: problem('validation_failed', 'Prices are whole millicredits ≥ 0 for features of this product.'),
			};
		const accepted = await connection.acceptedPrices();
		const features = currentFeatures(manifest, accepted).map((feature) => ({
			...feature,
			millicreditsPerHour: prices[feature.key] ?? feature.millicreditsPerHour,
		}));
		const list = { version: (accepted?.version ?? 0) + 1, features };
		try {
			await connection.active().client.putPrices(list);
		} catch (error) {
			return { ok: false, problem: portalProblem(error) };
		}
		await connection.savePrices(list);
		synced = true;
		const detail = features.map((f) => `${f.name}: ${f.millicreditsPerHour / 1000} credits/hour`).join(', ');
		await recent.record({ websiteId: null, who: actor, what: 'prices', detail });
		return { ok: true, version: list.version };
	};

	/**
	 * @param {{ websiteId: string, on: string[], actor: Who }} input
	 * @returns {Promise<{ ok: true, version: number, on: string[] } | { ok: false, problem: ProblemResult }>}
	 */
	const reportFeatures = async ({ websiteId, on, actor }) => {
		if (!Array.isArray(on) || new Set(on).size !== on.length || on.some((key) => !keys.includes(key)))
			return { ok: false, problem: problem('validation_failed', '`on` must list features of this product once each.') };
		const missing = missingDependencies(manifest, on);
		if (missing.length > 0) {
			const [feature, dep] = /** @type {[string, string]} */ (missing[0]);
			return { ok: false, problem: problem('validation_failed', `${feature} needs ${dep}, which is off.`) };
		}
		const found = await status.lookup(websiteId, { fresh: true });
		if (!found.ok)
			return {
				ok: false,
				problem: found.code === 'website_not_found' ? problem('website_not_found') : problem('portal_unreachable'),
			};
		const ordered = keys.filter((key) => on.includes(key));
		const version = found.status.featuresVersion + 1;
		try {
			await connection
				.active()
				.client.putFeatures(websiteId, { version, on: ordered, adminId: actor.id, adminName: actor.name });
		} catch (error) {
			return { ok: false, problem: portalProblem(error) };
		}
		await store.put('switches', websiteId, { websiteId, on: ordered, featuresVersion: version, at: now() });
		await status.drop(websiteId);
		const names = manifest.features.filter((f) => ordered.includes(f.key)).map((f) => f.name);
		await recent.record({
			websiteId,
			who: actor,
			what: 'features',
			detail: names.length > 0 ? `On: ${names.join(', ')}` : 'All features off',
		});
		return { ok: true, version, on: ordered };
	};

	/** After a deploy that changed the feature list: send the price report (kept prices, new features 0). */
	const syncManifest = async () => {
		if (synced || now() - triedAt < RETRY_MS || !connection.connected()) return;
		triedAt = now();
		const accepted = await connection.acceptedPrices();
		if (!accepted) return;
		const features = currentFeatures(manifest, accepted);
		if (!accepted.pending && !featuresDiffer(features, accepted.features)) {
			synced = true;
			return;
		}
		const list = { version: accepted.version + 1, features };
		try {
			await connection.active().client.putPrices(list);
			await connection.savePrices(list);
			synced = true;
		} catch (error) {
			const latest = await connection.acceptedPrices();
			// another instance reported first: nothing to retry here
			if (latest && latest.version > accepted.version) return;
			logger.warn('price report after a manifest change failed; retried on a later request', { error });
			await connection.savePrices(accepted, true);
		}
	};

	return Object.freeze({
		switches,
		/** @param {string} websiteId @param {string} key */
		isOn: async (websiteId, key) => (await switches(websiteId)).on.includes(key),
		reportPrices,
		reportFeatures,
		syncManifest,
	});
};

/** @typedef {ReturnType<typeof createReports>} Reports */
