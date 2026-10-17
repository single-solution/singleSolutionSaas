/**
 * The product → Portal client (PLAN 0.4.12). Every call except `jwks()` carries a fresh client assertion signed with
 * the product key pinned at connect (`@ss/protocol` `signAssertion`, audience = the pinned Portal URL). Answers are
 * checked with `@ss/contracts`. Failures throw a kit error: `portal_unreachable` (network, timeout, 5xx or an answer
 * that does not match the contract) or `portal_refused` (4xx, with `details.status` and `details.problem`, the
 * Portal's problem code).
 * @module
 */
import {
	validateConnectionHealth,
	validateDirectory,
	validateDirectoryList,
	validateRevocations,
	validateStatusResponse,
	validateWebsiteConnections,
	validateWebsiteSettings,
	validateWebsitesPage,
} from '@ss/contracts';
import { signAssertion } from '@ss/protocol';
import { isObject } from '@ss/contracts/util';
import { kitError } from './util.js';

/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('@ss/contracts').PriceList} PriceList */
/** @typedef {import('@ss/contracts').StatusResponse} StatusResponse */
/** @typedef {import('@ss/contracts').WebsitesPage} WebsitesPage */
/** @typedef {import('@ss/contracts').Revocations} Revocations */
/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {import('@ss/contracts').WebsiteConnections} WebsiteConnections */

/** Deadline of one Portal call (a call may ask for a shorter one). */
const PORTAL_TIMEOUT_MS = 10_000;

/**
 * @param {{ portalUrl: string, productId: string, signer: Signer, fetch?: typeof globalThis.fetch, now?: () => number,
 *   randomBytes?: (length: number) => Uint8Array }} options `portalUrl` is the pinned, canonical Portal URL
 */
export const createPortalClient = ({ portalUrl, productId, signer, fetch = globalThis.fetch, now = Date.now, randomBytes }) => {
	/**
	 * @param {'GET' | 'POST' | 'PUT'} method
	 * @param {string} path
	 * @param {{ body?: unknown, signed?: boolean, timeoutMs?: number }} [options]
	 * @returns {Promise<any>}
	 */
	const call = async (method, path, { body, signed = true, timeoutMs = PORTAL_TIMEOUT_MS } = {}) => {
		const route = path.split('?')[0];
		/** @type {Record<string, string>} */
		const headers = { accept: 'application/json' };
		if (signed) {
			const assertion = await signAssertion({
				signer,
				productId,
				audience: portalUrl,
				now,
				...(randomBytes ? { randomBytes } : {}),
			});
			headers.authorization = `Bearer ${assertion}`;
		}
		if (body !== undefined) headers['content-type'] = 'application/json';
		/** @type {Response} */
		let response;
		/** @type {unknown} */
		let json = null;
		try {
			response = await fetch(`${portalUrl}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(timeoutMs),
				redirect: 'error',
			});
			const text = await response.text();
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			throw kitError('portal_unreachable', `Portal ${method} ${route} failed`);
		}
		if (response.status >= 500) throw kitError('portal_unreachable', `Portal ${method} ${route} answered ${response.status}`);
		if (!response.ok) {
			const type = isObject(json) && typeof json.type === 'string' ? json.type : '';
			throw kitError('portal_refused', `Portal ${method} ${route} answered ${response.status}`, {
				status: response.status,
				problem: type.split('/').pop() ?? '',
			});
		}
		return json;
	};

	/**
	 * @template T
	 * @param {{ ok: true, value: T } | { ok: false }} result
	 * @param {string} what
	 * @returns {T}
	 */
	const checked = (result, what) => {
		if (!result.ok) throw kitError('portal_unreachable', `Portal ${what} answer does not match the contract`);
		return result.value;
	};
	/** @param {unknown} json @param {string} what @returns {number} */
	const versionOf = (json, what) => {
		if (!isObject(json) || !Number.isSafeInteger(json.version))
			throw kitError('portal_unreachable', `Portal ${what} answer has no version`);
		return /** @type {number} */ (json.version);
	};

	return Object.freeze({
		/** @returns {Promise<unknown>} the Portal's public keys (unsigned call) */
		jwks: () => call('GET', '/.well-known/jwks.json', { signed: false }),
		/** @param {PriceList} report @returns {Promise<{ version: number }>} */
		putPrices: async (report) => ({ version: versionOf(await call('PUT', '/v1/product/prices', { body: report }), 'prices') }),
		/**
		 * @param {string} websiteId
		 * @param {{ version: number, on: string[], adminId: string, adminName: string }} report
		 * @returns {Promise<{ version: number }>}
		 */
		putFeatures: async (websiteId, report) => ({
			version: versionOf(
				await call('PUT', `/v1/product/websites/${encodeURIComponent(websiteId)}/features`, { body: report }),
				'features',
			),
		}),
		/**
		 * @param {string} websiteId
		 * @param {{ timeoutMs?: number }} [options] a shorter deadline for a request that waits for the answer
		 * @returns {Promise<StatusResponse>}
		 */
		status: async (websiteId, { timeoutMs } = {}) =>
			checked(
				validateStatusResponse(
					await call('GET', `/v1/product/websites/${encodeURIComponent(websiteId)}/status`, timeoutMs ? { timeoutMs } : {}),
				),
				'status',
			),
		/**
		 * The website's settings when the Portal holds a version newer than `since` (else `settings` is null). Checked: the
		 * document must be valid, be this website's and carry the version the answer names.
		 * @param {string} websiteId
		 * @param {{ since?: number, timeoutMs?: number }} [options]
		 * @returns {Promise<{ version: number, settings: WebsiteSettings | null }>}
		 */
		websiteSettings: async (websiteId, { since = 0, timeoutMs } = {}) => {
			const json = await call(
				'GET',
				`/v1/product/websites/${encodeURIComponent(websiteId)}/settings${since > 0 ? `?since=${since}` : ''}`,
				timeoutMs ? { timeoutMs } : {},
			);
			const version = versionOf(json, 'website settings');
			const settings = isObject(json) ? json.settings : null;
			if (settings === null || settings === undefined) return { version, settings: null };
			const document = checked(validateWebsiteSettings(settings), 'website settings');
			if (document.websiteId !== websiteId || document.version !== version)
				throw kitError('portal_unreachable', 'Portal website settings answer names another website or version');
			return { version, settings: document };
		},
		/**
		 * The website's connections for this product: its database (with its own name), its storage and its links (the
		 * keys it calls other products with and who may call it). Checked: the answer must match the contract.
		 * @param {string} websiteId
		 * @param {{ timeoutMs?: number }} [options] a shorter deadline for a use that waits
		 * @returns {Promise<WebsiteConnections>}
		 */
		websiteConnections: async (websiteId, { timeoutMs } = {}) =>
			checked(
				validateWebsiteConnections(
					await call(
						'GET',
						`/v1/product/websites/${encodeURIComponent(websiteId)}/connections`,
						timeoutMs ? { timeoutMs } : {},
					),
				),
				'website connections',
			),
		/**
		 * Tell the Portal how a delivered connection worked (the Portal never opens the merchant's database or bucket).
		 * @param {string} websiteId
		 * @param {'database' | 'storage'} name
		 * @param {{ version: number, ok: boolean, message?: string }} report
		 * @returns {Promise<void>}
		 */
		reportHealth: async (websiteId, name, report) => {
			const body = checked(validateConnectionHealth(report), 'connection health');
			await call(
				'PUT',
				`/v1/product/websites/${encodeURIComponent(websiteId)}/connections/${encodeURIComponent(name)}/health`,
				{ body },
			);
		},
		/** @param {string | null} [cursor] @returns {Promise<WebsitesPage>} */
		websites: async (cursor) =>
			checked(
				validateWebsitesPage(
					await call('GET', `/v1/product/websites${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
				),
				'websites',
			),
		/**
		 * @param {string | null} [since]
		 * @param {{ timeoutMs?: number }} [options] a shorter deadline for a request that waits for the answer
		 * @returns {Promise<Revocations>}
		 */
		revocations: async (since, { timeoutMs } = {}) =>
			checked(
				validateRevocations(
					await call(
						'GET',
						`/v1/product/revocations${since ? `?since=${encodeURIComponent(since)}` : ''}`,
						timeoutMs ? { timeoutMs } : {},
					),
				),
				'revocations',
			),
		/** @param {string} id @returns {Promise<{ baseUrl: string }>} */
		directory: async (id) =>
			checked(validateDirectory(await call('GET', `/v1/product/directory/${encodeURIComponent(id)}`)), 'directory'),
		/** Every connected product with its name and address, by id. @returns {Promise<import('@ss/contracts').DirectoryList>} */
		directoryList: async () => checked(validateDirectoryList(await call('GET', '/v1/product/directory')), 'directory'),
		/** @param {string} jti @returns {Promise<{ consumed: boolean }>} */
		consumeLaunch: async (jti) => {
			const json = await call('POST', '/v1/product/launch/consume', { body: { jti } });
			return { consumed: isObject(json) && json.consumed === true };
		},
	});
};

/** @typedef {ReturnType<typeof createPortalClient>} PortalClient */
