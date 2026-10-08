/**
 * Growth's calls to the web, all through `@ss/net` (PLAN 0.10): reading the merchant's own pages for the SEO checklist
 * and sending an IndexNow submission. Both run only when the merchant asks (widget or API); nothing is fetched on a
 * timer.
 * @module
 */
import { INDEXNOW_ENDPOINT } from '../core/seo.js';

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {import('../core/seo.js').Fetched} Fetched */

/** Time and size limits of one page read. */
const PAGE_TIMEOUT_MS = 8_000;
const PAGE_MAX_BYTES = 1_048_576;
/** Time limit of an IndexNow submission. */
const INDEXNOW_TIMEOUT_MS = 10_000;

const USER_AGENT = 'SingleSolution-Growth-SEO/1 (SEO checklist on request of the site owner)';

/**
 * @param {{ send: OutboundSend }} deps
 */
export const createWeb = ({ send }) => {
	/**
	 * Read one page: its status, headers and text (null status when it could not be read).
	 * @param {string} url
	 * @param {{ statusOnly?: boolean }} [options] `statusOnly`: a body over the size limit still counts as answered (a
	 *   large sitemap)
	 * @returns {Promise<Fetched>}
	 */
	const read = async (url, { statusOnly = false } = {}) => {
		try {
			const response = await send(url, {
				headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/xml;q=0.9,*/*;q=0.5' },
				timeoutMs: PAGE_TIMEOUT_MS,
				maxBytes: PAGE_MAX_BYTES,
			});
			return { url, status: response.status, headers: response.headers, body: response.body.toString('utf8') };
		} catch (error) {
			const tooLarge = /** @type {{ code?: string }} */ (error)?.code === 'too_large';
			return { url, status: statusOnly && tooLarge ? 200 : null, headers: {}, body: '' };
		}
	};

	/**
	 * Send an IndexNow submission; what the endpoint answered.
	 * @param {{ host: string, key: string, keyLocation: string, urlList: string[] }} body
	 * @returns {Promise<{ ok: boolean, status: number | null }>}
	 */
	const indexNow = async (body) => {
		try {
			const response = await send(INDEXNOW_ENDPOINT, {
				method: 'POST',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				body: JSON.stringify(body),
				timeoutMs: INDEXNOW_TIMEOUT_MS,
				redirect: 'manual',
			});
			return { ok: response.status === 200 || response.status === 202, status: response.status };
		} catch {
			return { ok: false, status: null };
		}
	};

	return Object.freeze({ read, indexNow });
};

/** @typedef {ReturnType<typeof createWeb>} Web */
