/**
 * Growth's calls to the web, all through `@ss/net` (PLAN 0.10: https only, public addresses only, every DNS answer
 * checked): reading the merchant's own site for the SEO checklist and sending an IndexNow submission. Both run only
 * when the merchant asks (widget or API); nothing is fetched on a timer. A read never follows a redirect (the checks
 * judge the redirect itself), has a time limit (and stops at the run's deadline) and a size limit, and reads at most a
 * few addresses at a time, so a check never weighs on the merchant's site.
 * @module
 */
import { gunzipSync } from 'node:zlib';
import { INDEXNOW_ENDPOINT } from '../core/seo.js';

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {import('../core/seo-checks.js').Fetched} Fetched */

/** Time limit of one read. */
export const READ_TIMEOUT_MS = 8_000;
/** A read is not started with less time than this left before the run's deadline. */
const MIN_READ_MS = 500;
/** Size limit of a page: Google reads the first 2 MB of an HTML file, so a larger page fails its check. */
export const PAGE_MAX_BYTES = 2_097_152;
/** Size limit of a sitemap file read for samples (the sitemap protocol allows 50 MB; a larger one is reported). */
export const SITEMAP_MAX_BYTES = 16_777_216;
/** Reads of the merchant's site at once. */
export const READS_AT_ONCE = 4;
/** Time limit of an IndexNow submission. */
const INDEXNOW_TIMEOUT_MS = 10_000;

const USER_AGENT = 'Shelfway-Growth-SEO/1 (SEO checklist on request of the site owner)';

/**
 * The text of a body: a gzipped file (a `sitemap.xml.gz`, which search engines read) unpacked, never past `maxBytes`
 * (then it throws `too_large`); bytes that are no gzip as they are.
 * @param {Buffer} body
 * @param {number} maxBytes
 */
const textOf = (body, maxBytes) => {
	if (body[0] !== 0x1f || body[1] !== 0x8b) return body.toString('utf8');
	try {
		return gunzipSync(body, { maxOutputLength: maxBytes }).toString('utf8');
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === 'ERR_BUFFER_TOO_LARGE')
			throw Object.assign(error, { code: 'too_large' });
		return body.toString('utf8');
	}
};

/**
 * @param {{ send: OutboundSend, clock?: () => number }} deps `clock`: milliseconds for the run's deadline and the
 *   response times (a monotonic clock by default)
 */
export const createWeb = ({ send, clock = () => performance.now() }) => {
	/**
	 * The deadline of a run that may take `ms` from now.
	 * @param {number} ms
	 */
	const deadline = (ms) => clock() + ms;

	/**
	 * Read one address: its status (a redirect as it is, never followed), headers, text (a gzipped file unpacked) and the
	 * time it took; status null with the reason when it could not be read (`time`: the run's deadline came first, so it
	 * was not asked).
	 * @param {string} url
	 * @param {{ maxBytes?: number, until?: number }} [options] `until`: the run's deadline
	 * @returns {Promise<Fetched>}
	 */
	const read = async (url, { maxBytes = PAGE_MAX_BYTES, until = Number.POSITIVE_INFINITY } = {}) => {
		const left = until - clock();
		if (left < MIN_READ_MS) return { url, status: null, headers: {}, body: '', ms: null, error: 'time' };
		const started = clock();
		try {
			const response = await send(url, {
				headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/xml;q=0.9,*/*;q=0.5' },
				timeoutMs: Math.floor(Math.min(READ_TIMEOUT_MS, left)),
				maxBytes,
				redirect: 'manual',
			});
			return {
				url,
				status: response.status,
				headers: response.headers,
				body: textOf(response.body, maxBytes),
				ms: clock() - started,
				error: null,
			};
		} catch (error) {
			const code = /** @type {{ code?: string }} */ (error)?.code;
			return {
				url,
				status: null,
				headers: {},
				body: '',
				ms: null,
				error: code === 'timeout' ? 'timeout' : code === 'too_large' ? 'too_large' : 'unreachable',
			};
		}
	};

	/**
	 * Read several addresses, at most {@link READS_AT_ONCE} at a time; the reads in the order asked.
	 * @param {string[]} urls
	 * @param {{ maxBytes?: number, until?: number }} [options]
	 * @returns {Promise<Fetched[]>}
	 */
	const readAll = async (urls, options) => {
		/** @type {Fetched[]} */
		const reads = new Array(urls.length);
		let next = 0;
		const worker = async () => {
			while (next < urls.length) {
				const index = next;
				next += 1;
				reads[index] = await read(/** @type {string} */ (urls[index]), options);
			}
		};
		await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, urls.length) }, worker));
		return reads;
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

	return Object.freeze({ deadline, read, readAll, indexNow });
};

/** @typedef {ReturnType<typeof createWeb>} Web */
