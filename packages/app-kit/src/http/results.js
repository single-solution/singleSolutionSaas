/**
 * Route result helpers. Handlers return (or throw) these; the request handler renders them. `problem()` results are
 * rendered as RFC 9457 documents with the product's type base URI and the request id.
 * @module
 */
import { PROBLEM_CODES } from '@ss/contracts';
import { isObject } from '../util.js';

const BRAND = Symbol.for('ss.app-kit.result');

/**
 * @typedef {{ [BRAND]: 'response', status: number, body: unknown, headers: Record<string, string> }} ResponseResult
 * @typedef {{ [BRAND]: 'problem', code: string, status?: number, detail?: string, errors?: Array<{ path: string, message: string, keyword?: string, code?: string }>, headers: Record<string, string> }} ProblemResult
 * @typedef {ResponseResult | ProblemResult} RouteResult
 */

/**
 * A JSON response (default 200).
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 * @returns {ResponseResult}
 */
export const ok = (body, { status = 200, headers = {} } = {}) => ({ [BRAND]: 'response', status, body, headers });

/**
 * 201 Created, with an optional `Location`.
 * @param {unknown} body
 * @param {{ location?: string, headers?: Record<string, string> }} [init]
 * @returns {ResponseResult}
 */
export const created = (body, { location, headers = {} } = {}) =>
	ok(body, { status: 201, headers: { ...headers, ...(location ? { location } : {}) } });

/** 204 No Content. @returns {ResponseResult} */
export const noContent = () => ok(undefined, { status: 204 });

/**
 * An RFC 9457 problem for a registered code (`@ss/contracts` `PROBLEM_CODES` or the product's own codes).
 * @param {string} code
 * @param {string} [detail]
 * @param {{ errors?: ProblemResult['errors'], headers?: Record<string, string>, status?: number }} [extra]
 * @returns {ProblemResult}
 */
export const problem = (code, detail, { errors, headers = {}, status } = {}) => ({
	[BRAND]: 'problem',
	code,
	...(status === undefined ? {} : { status }),
	...(detail === undefined ? {} : { detail }),
	...(errors === undefined ? {} : { errors }),
	headers,
});

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const brandOf = (value) => (isObject(value) ? /** @type {Record<symbol, unknown>} */ (value)[BRAND] : undefined);

/**
 * @param {unknown} value
 * @returns {value is RouteResult}
 */
export const isResult = (value) => brandOf(value) === 'response' || brandOf(value) === 'problem';

/**
 * @param {unknown} value
 * @returns {value is ProblemResult}
 */
export const isProblem = (value) => brandOf(value) === 'problem';

/** Status of a built-in code (500 for unknown codes). @param {string} code */
export const statusOf = (code) =>
	Object.hasOwn(PROBLEM_CODES, code) ? PROBLEM_CODES[/** @type {keyof typeof PROBLEM_CODES} */ (code)].status : 500;

/**
 * @param {unknown} value
 * @returns {string}
 */
const encodeCursor = (value) => Buffer.from(JSON.stringify({ k: value })).toString('base64url');

/**
 * @param {string} cursor
 * @returns {unknown}
 */
const decodeCursor = (cursor) => {
	if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw problem('bad_request', 'cursor is invalid');
	try {
		const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (!isObject(parsed) || !('k' in parsed)) throw new Error('shape');
		const key = parsed.k;
		if (typeof key !== 'string' && typeof key !== 'number') throw new Error('type');
		return key;
	} catch {
		throw problem('bad_request', 'cursor is invalid');
	}
};

/**
 * Cursor pagination (Part E §5): opaque cursors, `limit` bounded. Fetch `fetchLimit` (= limit + 1) items sorted by the
 * key and pass them to `page()`, which slices and returns the next cursor, or to `respond()`, which also emits
 * `Link: <url>; rel="next"` when a next page exists (`url` = the request URL, e.g. `ctx.request.url`).
 * @param {{ cursor?: string | null, limit?: string | number | null, url?: string | URL }} [input]
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @throws {ProblemResult} `bad_request` for an invalid cursor or limit
 */
export const paginate = ({ cursor, limit, url } = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
	/** @type {number} */
	let n = defaultLimit;
	if (limit !== undefined && limit !== null && limit !== '') {
		n = typeof limit === 'number' ? limit : /^\d{1,6}$/.test(limit) ? Number(limit) : Number.NaN;
		if (!Number.isInteger(n) || n < 1 || n > maxLimit) throw problem('bad_request', `limit must be 1..${maxLimit}`);
	}
	const after = cursor ? decodeCursor(cursor) : null;
	/**
	 * @template T
	 * @param {T[]} items
	 * @param {(item: T) => unknown} [keyOf]
	 * @returns {{ items: T[], nextCursor: string | null, hasMore: boolean }}
	 */
	const page = (items, keyOf = (item) => /** @type {any} */ (item)?.id) => {
		const hasMore = items.length > n;
		const slice = hasMore ? items.slice(0, n) : items;
		const last = slice[slice.length - 1];
		return { items: slice, nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null, hasMore };
	};
	/**
	 * `Link` header value for the next page, or null.
	 * @param {string | null} nextCursor
	 * @returns {string | null}
	 */
	const link = (nextCursor) => {
		if (!nextCursor || !url) return null;
		const next = new URL(url);
		next.searchParams.set('cursor', nextCursor);
		next.searchParams.set('limit', String(n));
		return `<${next.pathname}${next.search}>; rel="next"`;
	};
	return {
		limit: n,
		after,
		fetchLimit: n + 1,
		page,
		link,
		/**
		 * A 200 response `{ items, nextCursor, hasMore }` with the `Link` header.
		 * @template T
		 * @param {T[]} items
		 * @param {(item: T) => unknown} [keyOf]
		 * @returns {ResponseResult}
		 */
		respond: (items, keyOf) => {
			const body = page(items, keyOf);
			const header = link(body.nextCursor);
			return ok(body, { headers: header ? { link: header } : {} });
		},
	};
};
