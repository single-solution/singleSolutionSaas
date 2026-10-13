/**
 * The website's settings and lists (PLAN 0.8.10 Migration, order step 2): written through each product's settings API
 * for the merchant's server (K1) before the records, from the settings `read` took from the store (`settings.json`)
 * and the per-store settings table entered by hand. Every value is written explicitly, so a later change of a product
 * default never changes a moved website (RT-15): a setting counts as unchanged only when the website already holds
 * this exact value itself. A dry run writes nothing and lists the differences with the product's current values
 * (`from`, and where they come from: `website`, `default` or `built-in`) and what would be refused (unknown settings,
 * features that are off). Lists are compared by value (the API does not say where a list comes from), so a list equal
 * to what the product serves is left as it is. The settings API takes at most 60 writes a minute per website: a 429 waits as long as the
 * product asks and tries again.
 * @module
 */
import { isDeepStrictEqual } from 'node:util';
import { requestProduct } from './http.js';

/** @typedef {import('./mapping.js').SettingsPlan} SettingsPlan */
/** @typedef {import('./http.js').ProductTarget} ProductTarget */
/**
 * @typedef {object} SettingsChange
 * @property {string} product
 * @property {'format' | 'setting' | 'list'} kind
 * @property {string} key `<feature>.<setting>`, a Format field or a list name
 * @property {unknown} from the product's current value
 * @property {unknown} to
 * @property {string | null} source where the current value comes from (null for lists)
 */
/** @typedef {{ product: string, kind: 'format' | 'setting' | 'list', key: string, message: string }} SettingsRefusal */
/** @typedef {{ changes: SettingsChange[], unchanged: number, refused: SettingsRefusal[] }} SettingsReport */

/** Tries of one write the settings API asks to wait for. */
const WRITE_TRIES = 5;

/**
 * Merge settings plans: later plans win per product and per value (the hand-entered table over what was read).
 * @param {ReadonlyArray<SettingsPlan | null | undefined>} plans
 * @returns {SettingsPlan}
 */
export const mergePlans = (plans) => {
	/** @type {SettingsPlan} */
	const merged = {};
	for (const plan of plans)
		for (const [product, part] of Object.entries(plan ?? {})) {
			const into = (merged[product] ??= {});
			for (const kind of /** @type {const} */ (['format', 'settings', 'lists']))
				if (part[kind]) into[kind] = { ...into[kind], ...part[kind] };
		}
	return merged;
};

/**
 * Compare a plan with the products and, unless it is a dry run, write what differs.
 * @param {{ plan: SettingsPlan, products: Record<string, ProductTarget>, dryRun: boolean, fetch: typeof globalThis.fetch,
 *   sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<SettingsReport>}
 */
export const applySettings = async ({ plan, products, dryRun, fetch, sleep }) => {
	/** @type {SettingsReport} */
	const report = { changes: [], unchanged: 0, refused: [] };
	/**
	 * A write, waiting when the product asks to; the problem's message when refused.
	 * @param {ProductTarget} target @param {string} route @param {unknown} body
	 * @returns {Promise<string | null>}
	 */
	const write = async (target, route, body) => {
		for (let tries = 1; ; tries += 1) {
			const answer = await requestProduct(fetch, target, 'PUT', route, {
				body: JSON.stringify(body),
				type: 'application/json',
			});
			if (answer.status === 429 && tries < WRITE_TRIES) {
				await sleep(Math.max(1, Number(answer.headers.get('retry-after')) || 1) * 1000);
				continue;
			}
			if (answer.ok) return null;
			const errors = Array.isArray(answer.json?.errors)
				? answer.json.errors.map((/** @type {{ message?: string }} */ error) => error.message).filter(Boolean)
				: [];
			return [answer.json?.detail ?? `answered ${answer.status}`, ...errors].join(' ');
		}
	};
	for (const [product, part] of Object.entries(plan)) {
		const target = products[product];
		if (!target) {
			report.refused.push({ product, kind: 'setting', key: '*', message: `No address or server token for ${product}.` });
			continue;
		}
		/** @param {SettingsChange} change */
		const changed = (change) => report.changes.push(change);
		/** @param {SettingsRefusal['kind']} kind @param {string} key @param {string} message */
		const refuse = (kind, key, message) => report.refused.push({ product, kind, key, message });

		if (part.format && Object.keys(part.format).length > 0) {
			const current = (await requestProduct(fetch, target, 'GET', '/v1/format')).json ?? {};
			/** @type {Record<string, unknown>} */
			const fields = {};
			for (const [field, value] of Object.entries(part.format)) {
				const from = current.format?.[field];
				const source = current.sources?.[field] ?? null;
				if (source === 'website' && isDeepStrictEqual(from, value)) report.unchanged += 1;
				else {
					fields[field] = value;
					changed({ product, kind: 'format', key: field, from: from ?? null, to: value, source });
				}
			}
			if (!dryRun && Object.keys(fields).length > 0) {
				const refused = await write(target, '/v1/format', fields);
				if (refused) refuse('format', Object.keys(fields).join(', '), refused);
			}
		}

		if (part.settings && Object.keys(part.settings).length > 0) {
			const answer = await requestProduct(fetch, target, 'GET', '/v1/settings');
			/** @type {Array<{ key: string, on: boolean, schema?: { properties?: Record<string, unknown> }, values: Record<string, { value: unknown, source: string }> | null }>} */
			const features = Array.isArray(answer.json?.features) ? answer.json.features : [];
			for (const [full, value] of Object.entries(part.settings)) {
				const dot = full.indexOf('.');
				const feature = features.find((f) => f.key === full.slice(0, Math.max(dot, 0)));
				const key = full.slice(dot + 1);
				if (dot <= 0 || !feature || !Object.hasOwn(feature.schema?.properties ?? {}, key)) {
					refuse('setting', full, 'No such setting.');
					continue;
				}
				if (!feature.on || !feature.values) {
					refuse('setting', full, `The feature ${feature.key} is off.`);
					continue;
				}
				const now = feature.values[key];
				if (now?.source === 'website' && isDeepStrictEqual(now.value, value)) {
					report.unchanged += 1;
					continue;
				}
				changed({ product, kind: 'setting', key: full, from: now?.value ?? null, to: value, source: now?.source ?? null });
				if (!dryRun) {
					const refused = await write(target, `/v1/settings/${encodeURIComponent(full)}`, { value });
					if (refused) refuse('setting', full, refused);
				}
			}
		}

		for (const [name, value] of Object.entries(part.lists ?? {})) {
			const answer = await requestProduct(fetch, target, 'GET', `/v1/lists/${encodeURIComponent(name)}`);
			if (!answer.ok) {
				refuse('list', name, answer.json?.detail ?? `answered ${answer.status}`);
				continue;
			}
			if (isDeepStrictEqual(answer.json?.value, value)) {
				report.unchanged += 1;
				continue;
			}
			changed({ product, kind: 'list', key: name, from: answer.json?.value ?? null, to: value, source: null });
			if (!dryRun) {
				const refused = await write(target, `/v1/lists/${encodeURIComponent(name)}`, { value });
				if (refused) refuse('list', name, refused);
			}
		}
	}
	return report;
};
